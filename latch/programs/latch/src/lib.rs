//! LATCH kernel — a non-custodial, self-settling parimutuel market on Solana.
//!
//! One market = a monotone over-threshold predicate over a TxLINE soccer stat key.
//! Stakers back YES or NO into a non-custodial vault PDA. The market self-settles by a
//! CPI into the TxODDS `txoracle` program's `validate_stat`, which verifies the staked
//! outcome against the on-chain Merkle root (`daily_scores_roots`) and returns a bool —
//! the program cannot pay the wrong side because it never decides the outcome itself.
//!
//! v1 scope (the PRD's monotone "reached/over" wedge, fully built):
//!   - Markets are GreaterThan-only (monotone): the cumulative count can only cross the
//!     threshold once and then stays crossed, so a within-window proof is the rightful YES
//!     regardless of when settlement is cranked. LessThan/EqualTo are non-monotone and are
//!     rejected at creation (they require terminal-witness semantics — a v1.1 extension).
//!   - YES wins the whole pot, pro-rata, on the FIRST valid proof that the predicate holds.
//!   - If the predicate is never proven by `expiry_ts`, the market voids after a grace window
//!     and every staker (YES and NO) reclaims their original stake.
//!   - NO-as-pot-winner exists for PARLAYS (a bust at expiry → NO wins). Single-market NO is
//!     the parimutuel counterparty and is refunded on void; single-market NO-as-pot-winner via
//!     a terminal witness-leaf remains the documented v1.1 extension.
//!
//! Settlement binding (fund-safety): a submitted proof is bound to THIS market by fixture_id
//! AND stat key, single-stat only (no caller-supplied binary expression), and the proof
//! snapshot must fall within the market window (`ts <= expiry_ts`). The oracle roots account
//! is owner-pinned to the txoracle program. These together stop cross-fixture settlement,
//! predicate inflation, and forged-root attacks.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke, invoke_signed},
    system_instruction,
};

declare_id!("HBJKUPdL4g1K7jpJdPMACMDK6nhPc44gd8RaPtHgwhcG");

/// TxODDS `txoracle` program (devnet, full trading stack) — verified by the Phase-0 spike.
pub const TXORACLE_ID: Pubkey = anchor_lang::solana_program::pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
/// `global:validate_stat` discriminator, from the on-chain IDL, confirmed working in the spike.
pub const VALIDATE_STAT_DISC: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

pub const SIDE_YES: u8 = 1;
pub const SIDE_NO: u8 = 2;
pub const STATUS_OPEN: u8 = 0;
pub const STATUS_SETTLED_YES: u8 = 1;
pub const STATUS_VOID: u8 = 2;
pub const STATUS_PARLAY_NO: u8 = 3; // parlay busted by expiry → NO side wins
pub const MAX_LEGS: usize = 8;
pub const COMPARISON_GREATER_THAN: u8 = 0;
/// Grace window (seconds) after `expiry_ts` before a market can be voided / a parlay resolved to
/// NO. Gives the always-on keeper time to settle a within-window YES first, so the losing side
/// cannot grief the rightful winner by voiding/resolving the instant expiry passes. 120s is a
/// safety buffer for brief keeper downtime; a healthy keeper settles a rightful YES within seconds.
/// NOTE: `expiry_ts` is a UNIX wall-clock time in SECONDS (matches Clock::get().unix_timestamp);
/// the proof seed `ts` is in MILLISECONDS, so settle compares `ts / 1000 <= expiry_ts`.
pub const VOID_GRACE_SECS: i64 = 120;

// ───────── txoracle::validate_stat arg layout (exact Borsh, from the on-chain IDL) ─────────
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats { pub update_count: i32, pub min_timestamp: i64, pub max_timestamp: i64 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary { pub fixture_id: i64, pub update_stats: ScoresUpdateStats, pub events_sub_tree_root: [u8; 32] }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode { pub hash: [u8; 32], pub is_right_sibling: bool }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat { pub key: u32, pub value: i32, pub period: i32 }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm { pub stat_to_prove: ScoreStat, pub event_stat_root: [u8; 32], pub stat_proof: Vec<ProofNode> }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum Comparison { GreaterThan, LessThan, EqualTo }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TraderPredicate { pub threshold: i32, pub comparison: Comparison }
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum BinaryExpression { Add, Subtract }

/// The full `validate_stat` argument tuple, in IDL order. Borsh-serialised after the discriminator.
#[derive(AnchorSerialize)]
struct ValidateStatArgs {
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: TraderPredicate,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    op: Option<BinaryExpression>,
}

fn comparison_from_u8(c: u8) -> Result<Comparison> {
    Ok(match c {
        0 => Comparison::GreaterThan,
        1 => Comparison::LessThan,
        2 => Comparison::EqualTo,
        _ => return err!(KernelError::BadComparison),
    })
}

/// One leg of a parlay, as supplied at creation.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LegArg { pub stat_key: u32, pub period: i32, pub threshold: i32, pub comparison: u8 }

/// Shared CPI into txoracle::validate_stat → returns the bool verdict. Used by single markets
/// (via `settle`, inlined) and by each parlay leg. The oracle program AND the roots account are
/// both pinned to txoracle so neither can be spoofed.
fn prove_stat<'a>(
    txoracle: &AccountInfo<'a>,
    dsr: &AccountInfo<'a>,
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: TraderPredicate,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    op: Option<BinaryExpression>,
) -> Result<bool> {
    require_keys_eq!(*txoracle.key, TXORACLE_ID, KernelError::BadOracleProgram);
    require!(dsr.owner == &TXORACLE_ID, KernelError::BadOracleProgram);
    let args = ValidateStatArgs { ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, stat_b, op };
    let mut data = VALIDATE_STAT_DISC.to_vec();
    data.extend_from_slice(&args.try_to_vec()?);
    let ix = Instruction { program_id: TXORACLE_ID, accounts: vec![AccountMeta::new_readonly(*dsr.key, false)], data };
    invoke(&ix, &[dsr.clone(), txoracle.clone()])?;
    let (pid, ret) = get_return_data().ok_or(KernelError::NoVerdict)?;
    require_keys_eq!(pid, TXORACLE_ID, KernelError::NoVerdict);
    Ok(ret.first().copied().unwrap_or(0) == 1)
}

/// Seed a freshly-created vault PDA with the rent-exempt minimum so later pro-rata payouts that
/// leave a few lamports of dust never push the system-owned vault below rent-exemption (which would
/// make the final claim's transfer fail). Rent is provided by the market/parlay creator.
fn fund_vault_rent<'a>(authority: &Signer<'a>, vault: &UncheckedAccount<'a>, system_program: &Program<'a, System>) -> Result<()> {
    let rent_min = Rent::get()?.minimum_balance(0);
    invoke(
        &system_instruction::transfer(&authority.key(), &vault.key(), rent_min),
        &[authority.to_account_info(), vault.to_account_info(), system_program.to_account_info()],
    )?;
    Ok(())
}

#[program]
pub mod latch {
    use super::*;

    /// Open a parimutuel market on one monotone over-threshold soccer stat predicate.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        market_id: u64,
        fixture_id: i64,
        stat_key: u32,
        period: i32,
        threshold: i32,
        comparison: u8,
        lock_ts: i64,
        expiry_ts: i64,
    ) -> Result<()> {
        // v1 is monotone over-threshold only — see module docs (M4).
        require!(comparison == COMPARISON_GREATER_THAN, KernelError::OnlyGreaterThan);
        let now = Clock::get()?.unix_timestamp;
        require!(expiry_ts > now, KernelError::BadExpiry);
        // lock_ts is the hard cut-off for new stakes (KILL-1). It must sit in the future so the pool
        // is joinable, and no later than expiry so a stake can never land after the settlement window.
        // Flash pools (Freeze/Blackout) set it a few seconds out; period markets at the period start.
        require!(lock_ts > now && lock_ts <= expiry_ts, KernelError::BadLock);
        fund_vault_rent(&ctx.accounts.authority, &ctx.accounts.vault, &ctx.accounts.system_program)?;
        let m = &mut ctx.accounts.market;
        m.authority = ctx.accounts.authority.key();
        m.market_id = market_id;
        m.fixture_id = fixture_id;
        m.stat_key = stat_key;
        m.period = period;
        m.threshold = threshold;
        m.comparison = comparison;
        m.lock_ts = lock_ts;
        m.expiry_ts = expiry_ts;
        m.status = STATUS_OPEN;
        m.yes_total = 0;
        m.no_total = 0;
        m.settle_ts = 0;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Stake `amount` lamports on a side. Funds move into the non-custodial vault PDA.
    pub fn join_pool(ctx: Context<JoinPool>, side: u8, amount: u64) -> Result<()> {
        require!(ctx.accounts.market.status == STATUS_OPEN, KernelError::NotOpen);
        // KILL-1: no stake may land at or after the lock. This is what stops an oracle-latency
        // exploit — betting after the TV shows the event but before the anchor catches up.
        require!(Clock::get()?.unix_timestamp < ctx.accounts.market.lock_ts, KernelError::PoolLocked);
        require!(side == SIDE_YES || side == SIDE_NO, KernelError::BadSide);
        require!(amount > 0, KernelError::ZeroStake);

        invoke(
            &system_instruction::transfer(&ctx.accounts.user.key(), &ctx.accounts.vault.key(), amount),
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let pos = &mut ctx.accounts.position;
        pos.market = ctx.accounts.market.key();
        pos.owner = ctx.accounts.user.key();
        pos.side = side;
        pos.amount = pos.amount.checked_add(amount).ok_or(KernelError::Overflow)?;
        pos.claimed = false;
        pos.bump = ctx.bumps.position;

        let m = &mut ctx.accounts.market;
        if side == SIDE_YES {
            m.yes_total = m.yes_total.checked_add(amount).ok_or(KernelError::Overflow)?;
        } else {
            m.no_total = m.no_total.checked_add(amount).ok_or(KernelError::Overflow)?;
        }
        Ok(())
    }

    /// Self-settle: prove the market's predicate against the on-chain root via `validate_stat`.
    /// On a true result the market settles YES (final-on-first-proof). The kernel never decides
    /// the outcome — it only reads `validate_stat`'s verdict.
    pub fn settle(
        ctx: Context<Settle>,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_a: StatTerm,
        stat_b: Option<StatTerm>,
        op: Option<BinaryExpression>,
    ) -> Result<()> {
        {
            let m = &ctx.accounts.market;
            require!(m.status == STATUS_OPEN, KernelError::NotOpen);
            require_keys_eq!(ctx.accounts.txoracle_program.key(), TXORACLE_ID, KernelError::BadOracleProgram);
            // Owner-pin the roots account to txoracle so a forged roots account can't be supplied (H5).
            require!(ctx.accounts.daily_scores_merkle_roots.to_account_info().owner == &TXORACLE_ID, KernelError::BadOracleProgram);
            // Bind the proof fully to THIS market (C1/C2/H2):
            //  - fixture_id: the proof must be for this market's fixture (no cross-fixture settlement).
            //  - stat key: the predicate's stat. The key already encodes scope (e.g. 1 = full-match P1
            //    goals, 1001 = first-half), so the proof's `period` (the live game-phase at the snapshot)
            //    is intentionally not constrained — for a monotone over-threshold market this is sound.
            //  - single-stat only: no caller-supplied binary expression can inflate/deflate the value.
            //  - ts <= expiry: the proof snapshot must fall within the market window.
            require!(fixture_summary.fixture_id == m.fixture_id, KernelError::FixtureMismatch);
            require!(stat_a.stat_to_prove.key == m.stat_key, KernelError::StatMismatch);
            require!(stat_b.is_none() && op.is_none(), KernelError::BinaryNotAllowed);
            require!(ts / 1000 <= m.expiry_ts, KernelError::Expired); // proof ts is ms; expiry is unix seconds
        }

        // the market owns the predicate; the settler supplies only the proof
        let predicate = TraderPredicate {
            threshold: ctx.accounts.market.threshold,
            comparison: comparison_from_u8(ctx.accounts.market.comparison)?,
        };

        let args = ValidateStatArgs { ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, stat_b, op };
        let mut data = VALIDATE_STAT_DISC.to_vec();
        data.extend_from_slice(&args.try_to_vec()?);

        let ix = Instruction {
            program_id: TXORACLE_ID,
            accounts: vec![AccountMeta::new_readonly(ctx.accounts.daily_scores_merkle_roots.key(), false)],
            data,
        };
        invoke(
            &ix,
            &[
                ctx.accounts.daily_scores_merkle_roots.to_account_info(),
                ctx.accounts.txoracle_program.to_account_info(),
            ],
        )?;

        // read validate_stat's bool verdict from return data
        let (pid, ret) = get_return_data().ok_or(KernelError::NoVerdict)?;
        require_keys_eq!(pid, TXORACLE_ID, KernelError::NoVerdict);
        let predicate_true = ret.first().copied().unwrap_or(0) == 1;
        require!(predicate_true, KernelError::PredicateNotMet);

        let m = &mut ctx.accounts.market;
        if m.yes_total == 0 {
            // Predicate true but no one is on YES: there is no rightful winner, so refund both sides
            // (C3) rather than locking the pot in an unclaimable SETTLED_YES state.
            m.status = STATUS_VOID;
            emit!(MarketVoided { market: m.key(), market_id: m.market_id });
        } else {
            m.status = STATUS_SETTLED_YES;
            m.settle_ts = ts;
            emit!(MarketSettled { market: m.key(), market_id: m.market_id, winning_side: SIDE_YES, ts });
        }
        Ok(())
    }

    /// Void an unsettled market once it is past expiry + grace, enabling refunds. The grace window
    /// gives the keeper time to settle a within-window YES first, so a NO staker cannot void a
    /// rightful YES the instant expiry passes.
    pub fn void(ctx: Context<Void>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        require!(m.status == STATUS_OPEN, KernelError::NotOpen);
        let void_at = m.expiry_ts.checked_add(VOID_GRACE_SECS).ok_or(KernelError::Overflow)?;
        require!(now >= void_at, KernelError::NotExpired);
        m.status = STATUS_VOID;
        emit!(MarketVoided { market: m.key(), market_id: m.market_id });
        Ok(())
    }

    /// Claim winnings (settled-YES: pro-rata share of the whole pot) or a refund (voided: own stake).
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let payout: u64 = {
            let m = &ctx.accounts.market;
            let pos = &ctx.accounts.position;
            require!(!pos.claimed, KernelError::AlreadyClaimed);
            match m.status {
                STATUS_SETTLED_YES => {
                    require!(pos.side == SIDE_YES, KernelError::NotWinner);
                    require!(m.yes_total > 0, KernelError::Overflow);
                    let pot = (m.yes_total as u128).checked_add(m.no_total as u128).ok_or(KernelError::Overflow)?;
                    (pot.checked_mul(pos.amount as u128).ok_or(KernelError::Overflow)? / (m.yes_total as u128)) as u64
                }
                STATUS_VOID => pos.amount, // refund original stake (either side)
                _ => return err!(KernelError::NotResolved),
            }
        };

        // move lamports out of the vault PDA (the program signs for its own PDA)
        let market_key = ctx.accounts.market.key();
        let vault_bump = ctx.accounts.market.vault_bump;
        let seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[vault_bump]];
        invoke_signed(
            &system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.owner.key(), payout),
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;

        ctx.accounts.position.claimed = true;
        emit!(Claimed { market: market_key, owner: ctx.accounts.owner.key(), amount: payout });
        Ok(())
    }

    // ───────── Parlay: N-leg "all must hit" market (the multi-call slip) ─────────

    /// Open a parlay of N monotone over-threshold legs. YES = every leg hits; NO = it busts.
    pub fn create_parlay(ctx: Context<CreateParlay>, parlay_id: u64, fixture_id: i64, legs: Vec<LegArg>, lock_ts: i64, expiry_ts: i64) -> Result<()> {
        require!(!legs.is_empty() && legs.len() <= MAX_LEGS, KernelError::BadLegs);
        let now = Clock::get()?.unix_timestamp;
        require!(expiry_ts > now, KernelError::BadExpiry);
        // KILL-1: same lock discipline as single markets — joinable now, locked no later than expiry.
        require!(lock_ts > now && lock_ts <= expiry_ts, KernelError::BadLock);
        // v1 monotone over-threshold only (M4).
        for l in &legs { require!(l.comparison == COMPARISON_GREATER_THAN, KernelError::OnlyGreaterThan); }
        fund_vault_rent(&ctx.accounts.authority, &ctx.accounts.vault, &ctx.accounts.system_program)?;
        let p = &mut ctx.accounts.parlay;
        p.authority = ctx.accounts.authority.key();
        p.parlay_id = parlay_id;
        p.fixture_id = fixture_id;
        p.lock_ts = lock_ts;
        p.expiry_ts = expiry_ts;
        p.status = STATUS_OPEN;
        p.yes_total = 0; p.no_total = 0; p.legs_hit = 0; p.settle_ts = 0;
        p.legs = legs.iter().map(|l| Leg { stat_key: l.stat_key, period: l.period, threshold: l.threshold, comparison: l.comparison, hit: false }).collect();
        p.bump = ctx.bumps.parlay;
        p.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Stake YES (all legs hit) or NO (it busts) into the parlay's non-custodial vault.
    pub fn join_parlay(ctx: Context<JoinParlay>, side: u8, amount: u64) -> Result<()> {
        require!(ctx.accounts.parlay.status == STATUS_OPEN, KernelError::NotOpen);
        // KILL-1: no stake at or after the lock (see join_pool).
        require!(Clock::get()?.unix_timestamp < ctx.accounts.parlay.lock_ts, KernelError::PoolLocked);
        require!(side == SIDE_YES || side == SIDE_NO, KernelError::BadSide);
        require!(amount > 0, KernelError::ZeroStake);
        invoke(
            &system_instruction::transfer(&ctx.accounts.user.key(), &ctx.accounts.vault.key(), amount),
            &[ctx.accounts.user.to_account_info(), ctx.accounts.vault.to_account_info(), ctx.accounts.system_program.to_account_info()],
        )?;
        let pos = &mut ctx.accounts.position;
        pos.market = ctx.accounts.parlay.key();
        pos.owner = ctx.accounts.user.key();
        pos.side = side;
        pos.amount = pos.amount.checked_add(amount).ok_or(KernelError::Overflow)?;
        pos.claimed = false;
        pos.bump = ctx.bumps.position;
        let p = &mut ctx.accounts.parlay;
        if side == SIDE_YES { p.yes_total = p.yes_total.checked_add(amount).ok_or(KernelError::Overflow)?; }
        else { p.no_total = p.no_total.checked_add(amount).ok_or(KernelError::Overflow)?; }
        Ok(())
    }

    /// Prove one leg hit via validate_stat. When every leg is proven, the parlay settles YES.
    pub fn settle_leg(
        ctx: Context<SettleLeg>,
        leg_index: u8,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_a: StatTerm,
        stat_b: Option<StatTerm>,
        op: Option<BinaryExpression>,
    ) -> Result<()> {
        let predicate = {
            let p = &ctx.accounts.parlay;
            require!(p.status == STATUS_OPEN, KernelError::NotOpen);
            // Proof snapshot must fall within the parlay window (H2).
            require!(ts / 1000 <= p.expiry_ts, KernelError::Expired); // proof ts is ms; expiry is unix seconds
            let i = leg_index as usize;
            require!(i < p.legs.len(), KernelError::BadLegs);
            require!(!p.legs[i].hit, KernelError::AlreadyClaimed);
            // Bind the proof to THIS parlay's fixture and this leg's stat key, single-stat only (C1/C2).
            require!(fixture_summary.fixture_id == p.fixture_id, KernelError::FixtureMismatch);
            require!(stat_a.stat_to_prove.key == p.legs[i].stat_key, KernelError::StatMismatch);
            require!(stat_b.is_none() && op.is_none(), KernelError::BinaryNotAllowed);
            TraderPredicate { threshold: p.legs[i].threshold, comparison: comparison_from_u8(p.legs[i].comparison)? }
        };
        let txo = ctx.accounts.txoracle_program.to_account_info();
        let dsr = ctx.accounts.daily_scores_merkle_roots.to_account_info();
        let ok = prove_stat(&txo, &dsr, ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, stat_b, op)?;
        require!(ok, KernelError::PredicateNotMet);
        let p = &mut ctx.accounts.parlay;
        let i = leg_index as usize;
        p.legs[i].hit = true;
        p.legs_hit = p.legs_hit.checked_add(1).ok_or(KernelError::Overflow)?;
        if (p.legs_hit as usize) == p.legs.len() {
            if p.yes_total == 0 {
                // All legs hit but no one is on YES → refund both sides (C3) instead of locking.
                p.status = STATUS_VOID;
                emit!(MarketVoided { market: p.key(), market_id: p.parlay_id });
            } else {
                p.status = STATUS_SETTLED_YES;
                p.settle_ts = ts;
                emit!(MarketSettled { market: p.key(), market_id: p.parlay_id, winning_side: SIDE_YES, ts });
            }
        }
        Ok(())
    }

    /// After expiry + grace, if not all legs hit, the parlay busts → NO wins. The grace gives the
    /// keeper time to settle a final within-window leg first, so YES can't be denied at the boundary.
    pub fn resolve_parlay(ctx: Context<ResolveParlay>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.parlay;
        require!(p.status == STATUS_OPEN, KernelError::NotOpen);
        let resolve_at = p.expiry_ts.checked_add(VOID_GRACE_SECS).ok_or(KernelError::Overflow)?;
        require!(now >= resolve_at, KernelError::NotExpired);
        if p.no_total == 0 {
            // Busted but no one is on NO → refund both sides (C3) instead of locking.
            p.status = STATUS_VOID;
            emit!(MarketVoided { market: p.key(), market_id: p.parlay_id });
        } else {
            p.status = STATUS_PARLAY_NO;
            emit!(MarketSettled { market: p.key(), market_id: p.parlay_id, winning_side: SIDE_NO, ts: now });
        }
        Ok(())
    }

    /// Claim a parlay payout (winning side splits the pot pro-rata) or a void refund.
    pub fn claim_parlay(ctx: Context<ClaimParlay>) -> Result<()> {
        let payout: u64 = {
            let p = &ctx.accounts.parlay;
            let pos = &ctx.accounts.position;
            require!(!pos.claimed, KernelError::AlreadyClaimed);
            let pot = (p.yes_total as u128).checked_add(p.no_total as u128).ok_or(KernelError::Overflow)?;
            match p.status {
                STATUS_SETTLED_YES => {
                    require!(pos.side == SIDE_YES, KernelError::NotWinner);
                    require!(p.yes_total > 0, KernelError::Overflow);
                    (pot.checked_mul(pos.amount as u128).ok_or(KernelError::Overflow)? / (p.yes_total as u128)) as u64
                }
                STATUS_PARLAY_NO => {
                    require!(pos.side == SIDE_NO, KernelError::NotWinner);
                    require!(p.no_total > 0, KernelError::Overflow);
                    (pot.checked_mul(pos.amount as u128).ok_or(KernelError::Overflow)? / (p.no_total as u128)) as u64
                }
                STATUS_VOID => pos.amount,
                _ => return err!(KernelError::NotResolved),
            }
        };
        let pk = ctx.accounts.parlay.key();
        let vb = ctx.accounts.parlay.vault_bump;
        let seeds: &[&[u8]] = &[b"pvault", pk.as_ref(), &[vb]];
        invoke_signed(
            &system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.owner.key(), payout),
            &[ctx.accounts.vault.to_account_info(), ctx.accounts.owner.to_account_info(), ctx.accounts.system_program.to_account_info()],
            &[seeds],
        )?;
        ctx.accounts.position.claimed = true;
        emit!(Claimed { market: pk, owner: ctx.accounts.owner.key(), amount: payout });
        Ok(())
    }
}

// ───────────────────────── accounts ─────────────────────────
#[derive(Accounts)]
#[instruction(market_id: u64)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init, payer = authority, space = 8 + Market::INIT_SPACE,
        seeds = [b"market", market_id.to_le_bytes().as_ref()], bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: non-custodial lamport vault PDA for this market; system-owned, validated by seeds.
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct JoinPool<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: vault PDA, validated by seeds.
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        init_if_needed, payer = user, space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref(), &[side]], bump
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    pub settler: Signer<'info>, // permissionless: anyone can crank settlement
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: txoracle's daily_scores_roots PDA; owner-pinned to TXORACLE_ID in the handler, then
    /// passed through to validate_stat (read-only there).
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    /// CHECK: must be the txoracle program; enforced against TXORACLE_ID.
    pub txoracle_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Void<'info> {
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: vault PDA, validated by seeds.
    #[account(mut, seeds = [b"vault", market.key().as_ref()], bump = market.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        mut, has_one = owner @ KernelError::NotWinner,
        seeds = [b"position", market.key().as_ref(), owner.key().as_ref(), &[position.side]], bump = position.bump,
        constraint = position.market == market.key() @ KernelError::StatMismatch
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(parlay_id: u64)]
pub struct CreateParlay<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Parlay::INIT_SPACE, seeds = [b"parlay", parlay_id.to_le_bytes().as_ref()], bump)]
    pub parlay: Account<'info, Parlay>,
    /// CHECK: non-custodial vault PDA for this parlay; system-owned, validated by seeds.
    #[account(mut, seeds = [b"pvault", parlay.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side: u8)]
pub struct JoinParlay<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [b"parlay", parlay.parlay_id.to_le_bytes().as_ref()], bump = parlay.bump)]
    pub parlay: Account<'info, Parlay>,
    /// CHECK: vault PDA, validated by seeds.
    #[account(mut, seeds = [b"pvault", parlay.key().as_ref()], bump = parlay.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        init_if_needed, payer = user, space = 8 + Position::INIT_SPACE,
        seeds = [b"pposition", parlay.key().as_ref(), user.key().as_ref(), &[side]], bump
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettleLeg<'info> {
    pub settler: Signer<'info>,
    #[account(mut, seeds = [b"parlay", parlay.parlay_id.to_le_bytes().as_ref()], bump = parlay.bump)]
    pub parlay: Account<'info, Parlay>,
    /// CHECK: txoracle's daily_scores_roots PDA; owner-pinned to TXORACLE_ID in prove_stat, read-only inside validate_stat.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    /// CHECK: must be the txoracle program; enforced against TXORACLE_ID.
    pub txoracle_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ResolveParlay<'info> {
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"parlay", parlay.parlay_id.to_le_bytes().as_ref()], bump = parlay.bump)]
    pub parlay: Account<'info, Parlay>,
}

#[derive(Accounts)]
pub struct ClaimParlay<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [b"parlay", parlay.parlay_id.to_le_bytes().as_ref()], bump = parlay.bump)]
    pub parlay: Account<'info, Parlay>,
    /// CHECK: vault PDA, validated by seeds.
    #[account(mut, seeds = [b"pvault", parlay.key().as_ref()], bump = parlay.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(
        mut, has_one = owner @ KernelError::NotWinner,
        seeds = [b"pposition", parlay.key().as_ref(), owner.key().as_ref(), &[position.side]], bump = position.bump,
        constraint = position.market == parlay.key() @ KernelError::StatMismatch
    )]
    pub position: Account<'info, Position>,
    pub system_program: Program<'info, System>,
}

// ───────────────────────── state ─────────────────────────
#[account]
#[derive(InitSpace)]
pub struct Market {
    pub authority: Pubkey,
    pub market_id: u64,
    pub fixture_id: i64,
    pub stat_key: u32,
    pub period: i32,
    pub threshold: i32,
    pub comparison: u8, // YES predicate: 0 GreaterThan (v1 only)
    pub lock_ts: i64,   // KILL-1: hard cut-off for new stakes; join_pool rejects at/after this
    pub expiry_ts: i64,
    pub status: u8,
    pub yes_total: u64,
    pub no_total: u64,
    pub settle_ts: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub side: u8,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Leg {
    pub stat_key: u32,
    pub period: i32,
    pub threshold: i32,
    pub comparison: u8,
    pub hit: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Parlay {
    pub authority: Pubkey,
    pub parlay_id: u64,
    pub fixture_id: i64,
    #[max_len(8)]
    pub legs: Vec<Leg>,
    pub lock_ts: i64,   // KILL-1: hard cut-off for new stakes; join_parlay rejects at/after this
    pub expiry_ts: i64,
    pub status: u8,
    pub yes_total: u64,
    pub no_total: u64,
    pub legs_hit: u8,
    pub settle_ts: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

// ───────────────────────── events ─────────────────────────
#[event]
pub struct MarketSettled { pub market: Pubkey, pub market_id: u64, pub winning_side: u8, pub ts: i64 }
#[event]
pub struct MarketVoided { pub market: Pubkey, pub market_id: u64 }
#[event]
pub struct Claimed { pub market: Pubkey, pub owner: Pubkey, pub amount: u64 }

// ───────────────────────── errors ─────────────────────────
#[error_code]
pub enum KernelError {
    #[msg("Market is not open")] NotOpen,
    #[msg("Invalid side")] BadSide,
    #[msg("Stake must be > 0")] ZeroStake,
    #[msg("Arithmetic overflow")] Overflow,
    #[msg("Invalid comparison")] BadComparison,
    #[msg("txoracle program account mismatch")] BadOracleProgram,
    #[msg("Proof stat does not match the market")] StatMismatch,
    #[msg("Proof fixture does not match the market")] FixtureMismatch,
    #[msg("Binary expression not allowed for a single-stat market")] BinaryNotAllowed,
    #[msg("Proof snapshot is after the market window (ts > expiry)")] Expired,
    #[msg("Only GreaterThan (monotone over-threshold) markets are supported in v1")] OnlyGreaterThan,
    #[msg("Expiry must be in the future")] BadExpiry,
    #[msg("Lock must be in the future and no later than expiry")] BadLock,
    #[msg("Pool is locked — no new calls after the cut-off")] PoolLocked,
    #[msg("validate_stat returned no verdict")] NoVerdict,
    #[msg("Predicate not met — not settleable yet")] PredicateNotMet,
    #[msg("Market not yet expired")] NotExpired,
    #[msg("Already claimed")] AlreadyClaimed,
    #[msg("Caller is not on the winning side")] NotWinner,
    #[msg("Market not resolved")] NotResolved,
    #[msg("Invalid parlay legs")] BadLegs,
}
