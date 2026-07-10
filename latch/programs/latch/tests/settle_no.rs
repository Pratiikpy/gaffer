#![cfg(unix)]
//! `settle_no`, end to end, against the real oracle and a real anchored proof.
//!
//! The unit tests prove the arithmetic. This proves the thing that actually matters: that a fan who
//! backed NO, on a goal that never came, ends up with more lamports than they staked. Nothing here is
//! mocked. The TxODDS `txoracle` program is the binary dumped from devnet; `daily_scores_roots` is that
//! program's own anchored account, cloned byte for byte; and the proof bundle is a genuine
//! `stat-validation` response for fixture 18172379 — USA 2–0 Bosnia — proving Bosnia's goal count was 0.
//!
//! It cannot be done on devnet. `create_market` requires `expiry_ts > now`, and `settle_no` requires a
//! proof snapshot with `ts >= expiry_ts`. Every snapshot in the feed is in the past, so no market created
//! today can ever be settled NO by today's data — only by a match that finishes after it was opened.
//! Here the clock is ours: we open the market just before the snapshot's timestamp, warp past it, and let
//! the kernel and the oracle do exactly what they will do tonight at the final whistle.

use latch::{ProofNode, ScoreStat, ScoresBatchSummary, ScoresUpdateStats, StatTerm};
use mollusk_svm::{program, result::Check, Mollusk};
use solana_sdk::{
    account::{Account, WritableAccount},
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};


use anchor_lang::{AnchorSerialize, Discriminator};
use serde_json::Value;

const LATCH_ID: Pubkey = solana_sdk::pubkey!("HBJKUPdL4g1K7jpJdPMACMDK6nhPc44gd8RaPtHgwhcG");
const TXORACLE_ID: Pubkey = solana_sdk::pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const ROOTS: Pubkey = solana_sdk::pubkey!("FNLRxCxRf3idEDyixYg8uHj9xEVJSuqHvStxwRHf7k6e");

const SIDE_YES: u8 = 1;
const SIDE_NO: u8 = 2;
const STATUS_SETTLED_NO: u8 = 3;

fn arr32(v: &Value) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, x) in v.as_array().expect("array").iter().enumerate() {
        out[i] = x.as_u64().unwrap() as u8;
    }
    out
}

struct Proof {
    ts: i64,
    summary: ScoresBatchSummary,
    sub_tree: Vec<ProofNode>,
    main_tree: Vec<ProofNode>,
    term: StatTerm,
}

fn load_proof() -> Proof {
    let raw = include_str!("fixtures/proof.json");
    let j: Value = serde_json::from_str(raw).unwrap();
    let b = &j["bundle"];
    let nodes = |k: &str| -> Vec<ProofNode> {
        b[k].as_array()
            .unwrap()
            .iter()
            .map(|n| ProofNode { hash: arr32(&n["hash"]), is_right_sibling: n["isRightSibling"].as_bool().unwrap() })
            .collect()
    };
    let us = &b["summary"]["updateStats"];
    Proof {
        ts: us["minTimestamp"].as_i64().unwrap(),
        summary: ScoresBatchSummary {
            fixture_id: b["summary"]["fixtureId"].as_i64().unwrap(),
            update_stats: ScoresUpdateStats {
                update_count: us["updateCount"].as_i64().unwrap() as i32,
                min_timestamp: us["minTimestamp"].as_i64().unwrap(),
                max_timestamp: us["maxTimestamp"].as_i64().unwrap(),
            },
            events_sub_tree_root: arr32(&b["summary"]["eventStatsSubTreeRoot"]),
        },
        sub_tree: nodes("subTreeProof"),
        main_tree: nodes("mainTreeProof"),
        term: StatTerm {
            stat_to_prove: ScoreStat {
                key: b["statToProve"]["key"].as_u64().unwrap() as u32,
                value: b["statToProve"]["value"].as_i64().unwrap() as i32,
                period: b["statToProve"]["period"].as_i64().unwrap() as i32,
            },
            event_stat_root: arr32(&b["eventStatRoot"]),
            stat_proof: nodes("statProof"),
        },
    }
}

fn ix(data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
    Instruction { program_id: LATCH_ID, accounts: metas, data }
}

/// Anchor's on-the-wire encoding: 8-byte discriminator, then borsh args.
fn encode<T: AnchorSerialize>(disc: &[u8], args: &T) -> Vec<u8> {
    let mut d = disc.to_vec();
    d.extend(args.try_to_vec().unwrap());
    d
}

#[test]
fn a_no_backer_is_paid_the_pot_when_the_goal_never_came() {
    let proof = load_proof();
    // The market must shut exactly at the snapshot: `settle` allows ts <= expiry, `settle_no` ts >= expiry.
    let expiry: i64 = proof.ts / 1000;
    let lock: i64 = expiry - 60;

    let mut svm = Mollusk::new(&LATCH_ID, "latch");
    svm.add_program(&TXORACLE_ID, "txoracle", &program::loader_keys::LOADER_V3);

    // Open the market an hour before the snapshot exists; `create_market` demands expiry in the future.
    svm.sysvars.clock.unix_timestamp = expiry - 3600;

    let market_id: u64 = 42;
    let (market, _) = Pubkey::find_program_address(&[b"market", &market_id.to_le_bytes()], &LATCH_ID);
    let (vault, _) = Pubkey::find_program_address(&[b"vault", market.as_ref()], &LATCH_ID);
    let (config, _) = Pubkey::find_program_address(&[b"config"], &LATCH_ID);

    let authority = Pubkey::new_unique();
    let alice = Pubkey::new_unique(); // backs YES: "Bosnia to score"
    let bob = Pubkey::new_unique();   // backs NO:  "they won't"
    let fee_recipient = Pubkey::new_unique();

    let funded = |lamports: u64| Account::new(lamports, 0, &system_program::id());
    let roots_data = include_bytes!("fixtures/roots.bin").to_vec();
    let mut roots_acct = Account::new(65_145_600, roots_data.len(), &TXORACLE_ID);
    roots_acct.data_as_mut_slice().copy_from_slice(&roots_data);

    let mut accounts = vec![
        (authority, funded(10_000_000_000)),
        (alice, funded(10_000_000_000)),
        (bob, funded(10_000_000_000)),
        (fee_recipient, funded(1_000_000)),
        (market, Account::default()),
        (vault, Account::default()),
        (config, Account::default()),
        (ROOTS, roots_acct),
        // The oracle's own program account — `settle_no` passes it through to the CPI.
        (TXORACLE_ID, program::create_program_account_loader_v3(&TXORACLE_ID)),
        program::keyed_account_for_system_program(),
    ];

    let sys = system_program::id();
    let meta = |k: Pubkey, signer: bool, writable: bool| AccountMeta { pubkey: k, is_signer: signer, is_writable: writable };

    // init_config — claim reads the rake from it.
    let init = ix(
        encode(latch::instruction::InitConfig::DISCRIMINATOR, &latch::instruction::InitConfig { fee_recipient, rake_bps: 0 }),
        vec![meta(authority, true, true), meta(config, false, true), meta(sys, false, false)],
    );

    // create_market: "Bosnia to score" — stat 2 (away goals), threshold 0, GreaterThan.
    let create = ix(
        encode(
            latch::instruction::CreateMarket::DISCRIMINATOR,
            &latch::instruction::CreateMarket {
                market_id,
                fixture_id: proof.summary.fixture_id,
                stat_key: 2,
                period: 4,
                threshold: 0,
                comparison: 0,
                lock_ts: lock,
                expiry_ts: expiry,
            },
        ),
        vec![meta(authority, true, true), meta(market, false, true), meta(vault, false, true), meta(sys, false, false)],
    );

    let position = |owner: Pubkey, side: u8| {
        Pubkey::find_program_address(&[b"position", market.as_ref(), owner.as_ref(), &[side]], &LATCH_ID).0
    };
    let (pos_a, pos_b) = (position(alice, SIDE_YES), position(bob, SIDE_NO));
    accounts.push((pos_a, Account::default()));
    accounts.push((pos_b, Account::default()));

    let join = |user: Pubkey, pos: Pubkey, side: u8, amount: u64| {
        ix(
            encode(latch::instruction::JoinPool::DISCRIMINATOR, &latch::instruction::JoinPool { side, amount }),
            vec![meta(user, true, true), meta(market, false, true), meta(vault, false, true), meta(pos, false, true), meta(sys, false, false)],
        )
    };

    const YES_STAKE: u64 = 30_000_000; // 0.03
    const NO_STAKE: u64 = 50_000_000;  // 0.05
    const POT: u64 = YES_STAKE + NO_STAKE;

    let result = svm.process_and_validate_instruction_chain(
        &[
            (&init, &[Check::success()]),
            (&create, &[Check::success()]),
            (&join(alice, pos_a, SIDE_YES, YES_STAKE), &[Check::success()]),
            (&join(bob, pos_b, SIDE_NO, NO_STAKE), &[Check::success()]),
        ],
        &accounts,
    );
    let mut accounts: Vec<(Pubkey, Account)> = result.resulting_accounts.clone();

    // Bob is down his stake, and the pot is in the vault.
    let get = |accts: &Vec<(Pubkey, Account)>, k: Pubkey| accts.iter().find(|(p, _)| *p == k).unwrap().1.clone();
    let bob_after_stake = get(&accounts, bob).lamports;

    // The match ends. The snapshot exists. Nobody may settle NO until the keeper has had its head start.
    svm.sysvars.clock.unix_timestamp = expiry + 200;

    let settle_no = ix(
        encode(
            latch::instruction::SettleNo::DISCRIMINATOR,
            &latch::instruction::SettleNo {
                ts: proof.ts,
                fixture_summary: proof.summary.clone(),
                fixture_proof: proof.sub_tree.clone(),
                main_tree_proof: proof.main_tree.clone(),
                stat_a: proof.term.clone(),
            },
        ),
        vec![
            meta(authority, true, true),
            meta(market, false, true),
            meta(ROOTS, false, false),
            meta(TXORACLE_ID, false, false),
        ],
    );

    let after_settle = svm.process_and_validate_instruction(&settle_no, &accounts, &[Check::success()]);
    accounts = after_settle.resulting_accounts.clone();

    // The chain wrote SETTLED_NO. 8 bytes of discriminator, then the Market struct; status sits after
    // authority(32) + market_id(8) + fixture_id(8) + stat_key(4) + period(4) + threshold(4) + comparison(1)
    // + lock_ts(8) + expiry_ts(8).
    let market_acct = get(&accounts, market);
    let status = market_acct.data[8 + 32 + 8 + 8 + 4 + 4 + 4 + 1 + 8 + 8];
    assert_eq!(status, STATUS_SETTLED_NO, "the kernel must resolve the market against its predicate");

    // Bob collects. Alice cannot.
    let claim = |owner: Pubkey, pos: Pubkey| {
        ix(
            encode(latch::instruction::Claim::DISCRIMINATOR, &latch::instruction::Claim {}),
            vec![
                meta(owner, true, true),
                meta(market, false, true),
                meta(vault, false, true),
                meta(pos, false, true),
                meta(config, false, false),
                meta(fee_recipient, false, true),
                meta(sys, false, false),
            ],
        )
    };

    let alice_tries = svm.process_instruction(&claim(alice, pos_a), &accounts);
    assert!(alice_tries.program_result.is_err(), "the YES side must not be able to claim a market NO won");

    let paid = svm.process_and_validate_instruction(&claim(bob, pos_b), &accounts, &[Check::success()]);
    let bob_final = get(&paid.resulting_accounts.clone(), bob).lamports;

    // The whole point: Bob staked 0.05 on a goal that never came, and walks away with the 0.08 pot.
    let won = bob_final - bob_after_stake;
    assert_eq!(won, POT, "the NO side takes the entire pot, rake is 0");
    assert!(won > NO_STAKE, "backing NO must be able to PROFIT, not merely be refunded");

    let vault_left = get(&paid.resulting_accounts, vault).lamports;
    println!("\n  Bob staked {NO_STAKE} on NO, collected {won} — profit {}", won - NO_STAKE);
    println!("  vault retains {vault_left} lamports (rent only)\n");
}
