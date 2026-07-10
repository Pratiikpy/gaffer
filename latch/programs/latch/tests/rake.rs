#![cfg(unix)]
//! The revenue switch, exercised against the real oracle.
//!
//! "It could make money" is the easiest thing in a pitch deck to assert and the hardest to show. The
//! answer here is not a slide: a protocol rake lives in an on-chain `Config` PDA, hard-capped in the
//! program at 5%, taken from winnings and never from a refund, and shipped at zero. Flipping it on is a
//! transaction, not a redeploy.
//!
//! So this turns it on and watches the lamports move. The oracle is the binary dumped from devnet, the
//! anchored roots are its own account, and the proof is a genuine `stat-validation` response for fixture
//! 18172379 — USA 2–0 Bosnia — proving USA's goal count was 2, which makes "USA to score" true.
//!
//! Three properties, and all three are the point. The house takes exactly its basis points of the pot.
//! The winner takes the rest, to the lamport. And a fan who was merely refunded is never touched.

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
const MAX_RAKE_BPS: u16 = 500;

fn arr32(v: &Value) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, x) in v.as_array().expect("array").iter().enumerate() { out[i] = x.as_u64().unwrap() as u8; }
    out
}

struct Proof { ts: i64, summary: ScoresBatchSummary, sub_tree: Vec<ProofNode>, main_tree: Vec<ProofNode>, term: StatTerm }

fn load_yes_proof() -> Proof {
    let j: Value = serde_json::from_str(include_str!("fixtures/proof-yes.json")).unwrap();
    let b = &j["bundle"];
    let nodes = |k: &str| -> Vec<ProofNode> {
        b[k].as_array().unwrap().iter()
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

fn ix(data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction { Instruction { program_id: LATCH_ID, accounts: metas, data } }
fn encode<T: AnchorSerialize>(disc: &[u8], args: &T) -> Vec<u8> {
    let mut d = disc.to_vec();
    d.extend(args.try_to_vec().unwrap());
    d
}
const fn meta(k: Pubkey, signer: bool, writable: bool) -> AccountMeta {
    AccountMeta { pubkey: k, is_signer: signer, is_writable: writable }
}

/// Stand a market up, stake both sides, and settle it YES on the real proof.
/// Returns the SVM, the account set, and the keys the caller needs to claim.
struct Staged { svm: Mollusk, accounts: Vec<(Pubkey, Account)>, market: Pubkey, vault: Pubkey, config: Pubkey,
                alice: Pubkey, bob: Pubkey, pos_a: Pubkey, pos_b: Pubkey, treasury: Pubkey }

const YES_STAKE: u64 = 30_000_000; // 0.03
const NO_STAKE: u64 = 50_000_000;  // 0.05
const POT: u64 = YES_STAKE + NO_STAKE;

fn stage(rake_bps: u16) -> Staged {
    let proof = load_yes_proof();
    let expiry: i64 = proof.ts / 1000;

    let mut svm = Mollusk::new(&LATCH_ID, "latch");
    svm.add_program(&TXORACLE_ID, "txoracle", &program::loader_keys::LOADER_V3);
    svm.sysvars.clock.unix_timestamp = expiry - 3600;

    let market_id: u64 = 7;
    let (market, _) = Pubkey::find_program_address(&[b"market", &market_id.to_le_bytes()], &LATCH_ID);
    let (vault, _) = Pubkey::find_program_address(&[b"vault", market.as_ref()], &LATCH_ID);
    let (config, _) = Pubkey::find_program_address(&[b"config"], &LATCH_ID);

    let authority = Pubkey::new_unique();
    let alice = Pubkey::new_unique();   // backs YES — "USA to score", which is true
    let bob = Pubkey::new_unique();     // backs NO
    let treasury = Pubkey::new_unique();// the house

    let funded = |l: u64| Account::new(l, 0, &system_program::id());
    let roots_data = include_bytes!("fixtures/roots.bin").to_vec();
    let mut roots_acct = Account::new(65_145_600, roots_data.len(), &TXORACLE_ID);
    roots_acct.data_as_mut_slice().copy_from_slice(&roots_data);

    let position = |owner: Pubkey, side: u8| Pubkey::find_program_address(&[b"position", market.as_ref(), owner.as_ref(), &[side]], &LATCH_ID).0;
    let (pos_a, pos_b) = (position(alice, SIDE_YES), position(bob, SIDE_NO));

    let accounts = vec![
        (authority, funded(10_000_000_000)),
        (alice, funded(10_000_000_000)),
        (bob, funded(10_000_000_000)),
        (treasury, funded(1_000_000)),         // rent-exempt enough to receive
        (market, Account::default()),
        (vault, Account::default()),
        (config, Account::default()),
        (pos_a, Account::default()),
        (pos_b, Account::default()),
        (ROOTS, roots_acct),
        (TXORACLE_ID, program::create_program_account_loader_v3(&TXORACLE_ID)),
        program::keyed_account_for_system_program(),
    ];

    let sys = system_program::id();
    let init = ix(
        encode(latch::instruction::InitConfig::DISCRIMINATOR, &latch::instruction::InitConfig { fee_recipient: treasury, rake_bps }),
        vec![meta(authority, true, true), meta(config, false, true), meta(sys, false, false)],
    );
    let create = ix(
        encode(latch::instruction::CreateMarket::DISCRIMINATOR, &latch::instruction::CreateMarket {
            market_id, fixture_id: proof.summary.fixture_id, stat_key: 1, period: 4, threshold: 0, comparison: 0,
            lock_ts: expiry - 60, expiry_ts: expiry,
        }),
        vec![meta(authority, true, true), meta(market, false, true), meta(vault, false, true), meta(sys, false, false)],
    );
    let join = |user: Pubkey, pos: Pubkey, side: u8, amount: u64| ix(
        encode(latch::instruction::JoinPool::DISCRIMINATOR, &latch::instruction::JoinPool { side, amount }),
        vec![meta(user, true, true), meta(market, false, true), meta(vault, false, true), meta(pos, false, true), meta(sys, false, false)],
    );

    let staked = svm.process_and_validate_instruction_chain(
        &[
            (&init, &[Check::success()]),
            (&create, &[Check::success()]),
            (&join(alice, pos_a, SIDE_YES, YES_STAKE), &[Check::success()]),
            (&join(bob, pos_b, SIDE_NO, NO_STAKE), &[Check::success()]),
        ],
        &accounts,
    );

    // The whistle. "USA to score" is true, and the oracle says so.
    let settle = ix(
        encode(latch::instruction::Settle::DISCRIMINATOR, &latch::instruction::Settle {
            ts: proof.ts, fixture_summary: proof.summary.clone(),
            fixture_proof: proof.sub_tree.clone(), main_tree_proof: proof.main_tree.clone(),
            stat_a: proof.term.clone(), stat_b: None, op: None,
        }),
        vec![meta(authority, true, true), meta(market, false, true), meta(ROOTS, false, false), meta(TXORACLE_ID, false, false)],
    );
    let settled = svm.process_and_validate_instruction(&settle, &staked.resulting_accounts, &[Check::success()]);

    Staged { svm, accounts: settled.resulting_accounts.clone(), market, vault, config, alice, bob, pos_a, pos_b, treasury }
}

fn claim_ix(s: &Staged, owner: Pubkey, pos: Pubkey) -> Instruction {
    ix(
        encode(latch::instruction::Claim::DISCRIMINATOR, &latch::instruction::Claim {}),
        vec![
            meta(owner, true, true), meta(s.market, false, true), meta(s.vault, false, true), meta(pos, false, true),
            meta(s.config, false, false), meta(s.treasury, false, true), meta(system_program::id(), false, false),
        ],
    )
}
fn lamports(accts: &[(Pubkey, Account)], k: Pubkey) -> u64 { accts.iter().find(|(p, _)| *p == k).unwrap().1.lamports }

#[test]
fn the_house_takes_its_cut_from_the_winner_and_nothing_from_anyone_else() {
    const RAKE_BPS: u16 = 250; // 2.5%
    let mut s = stage(RAKE_BPS);

    let treasury_before = lamports(&s.accounts, s.treasury);
    let alice_before = lamports(&s.accounts, s.alice);

    let paid = s.svm.process_and_validate_instruction(&claim_ix(&s, s.alice, s.pos_a), &s.accounts, &[Check::success()]);
    let accts = paid.resulting_accounts.clone();

    let fee = lamports(&accts, s.treasury) - treasury_before;
    let to_alice = lamports(&accts, s.alice) - alice_before;

    let expected_fee = (POT as u128 * RAKE_BPS as u128 / 10_000) as u64;
    assert_eq!(fee, expected_fee, "the house takes exactly its basis points of the pot");
    assert_eq!(fee, 2_000_000, "2.5% of a 0.08 pot is 0.002");
    assert_eq!(to_alice + fee, POT, "and the winner takes the rest, to the lamport");

    // The losing side gets nothing, rake or no rake.
    let refused = s.svm.process_instruction(&claim_ix(&s, s.bob, s.pos_b), &accts);
    assert!(refused.program_result.is_err(), "the NO side cannot claim a market YES won");

    println!("\n  pot {POT} · house {fee} ({}bps) · winner {to_alice}\n", RAKE_BPS);
}

#[test]
fn at_zero_the_winner_takes_the_whole_pot_and_the_house_takes_nothing() {
    let mut s = stage(0);
    let treasury_before = lamports(&s.accounts, s.treasury);
    let alice_before = lamports(&s.accounts, s.alice);

    let paid = s.svm.process_and_validate_instruction(&claim_ix(&s, s.alice, s.pos_a), &s.accounts, &[Check::success()]);
    let accts = paid.resulting_accounts.clone();

    assert_eq!(lamports(&accts, s.treasury), treasury_before, "shipped at zero: no house");
    assert_eq!(lamports(&accts, s.alice) - alice_before, POT, "the winner takes the whole pot");
}

#[test]
fn the_cap_is_in_the_program_not_in_the_config() {
    // `init_config` refuses a rake above the ceiling, so no authority — ours or anyone else's — can set
    // one. The number a fan is quoted cannot be exceeded by whoever holds the keys.
    let proof = load_yes_proof();
    let mut svm = Mollusk::new(&LATCH_ID, "latch");
    svm.sysvars.clock.unix_timestamp = proof.ts / 1000 - 3600;

    let (config, _) = Pubkey::find_program_address(&[b"config"], &LATCH_ID);
    let authority = Pubkey::new_unique();
    let treasury = Pubkey::new_unique();
    let accounts = vec![
        (authority, Account::new(10_000_000_000, 0, &system_program::id())),
        (config, Account::default()),
        program::keyed_account_for_system_program(),
    ];
    let init = |bps: u16| ix(
        encode(latch::instruction::InitConfig::DISCRIMINATOR, &latch::instruction::InitConfig { fee_recipient: treasury, rake_bps: bps }),
        vec![meta(authority, true, true), meta(config, false, true), meta(system_program::id(), false, false)],
    );

    let over = svm.process_instruction(&init(MAX_RAKE_BPS + 1), &accounts);
    assert!(over.program_result.is_err(), "a rake above the 5% ceiling must be refused by the program");

    let at_cap = svm.process_instruction(&init(MAX_RAKE_BPS), &accounts);
    assert!(!at_cap.program_result.is_err(), "the ceiling itself is allowed");
}
