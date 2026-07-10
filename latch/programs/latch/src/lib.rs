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
/// Market resolved AGAINST the predicate: proven not to have happened, so the NO side takes the pot.
/// Shares the discriminant with `STATUS_PARLAY_NO` — different account type, same meaning: "NO won".
pub const STATUS_SETTLED_NO: u8 = 3;
pub const MAX_LEGS: usize = 8;
pub const COMPARISON_GREATER_THAN: u8 = 0;
/// Grace window (seconds) after `expiry_ts` before a market can be voided / a parlay resolved to
/// NO. Gives the always-on keeper time to settle a within-window YES first, so the losing side
/// cannot grief the rightful winner by voiding/resolving the instant expiry passes. 120s is a
/// safety buffer for brief keeper downtime; a healthy keeper settles a rightful YES within seconds.
/// NOTE: `expiry_ts` is a UNIX wall-clock time in SECONDS (matches Clock::get().unix_timestamp);
/// the proof seed `ts` is in MILLISECONDS, so settle compares `ts / 1000 <= expiry_ts`.
pub const VOID_GRACE_SECS: i64 = 120;

/// How long the keeper gets to prove an outcome — either way — before anyone may void the pool.
///
/// `void` refunds both sides. Once `settle_no` exists, an early void is a *griefing vector*: the losing
/// YES side could wait out `VOID_GRACE_SECS`, void the market, and claw its stake back from NO backers
/// who had rightfully won. So voiding is now the last resort it was always meant to be — reachable only
/// after an hour in which nobody could prove the stat either above or below its threshold. A healthy
/// keeper settles within seconds of the oracle anchoring, and settlement always beats a void.
pub const RESOLVE_GRACE_SECS: i64 = 3600;

/// Commercial floor (the revenue switch, provably bounded). The protocol may take a parimutuel rake
/// from WINNINGS only (never a void refund), read from the singleton `Config` PDA at claim time. It is
/// hard-capped in-program at `MAX_RAKE_BPS` — the kernel will never take more than this no matter what
/// the authority sets — and ships at 0 (no house cut today). Flipping the switch turns on revenue with
/// zero redeploy; the cap makes the ceiling verifiable on-chain, not a promise in a doc.
pub const MAX_RAKE_BPS: u16 = 500; // 5.00% hard ceiling
pub const BPS_DENOM: u128 = 10_000;

/// Split a gross payout into (net_to_winner, house_fee) using the current rake. Rake applies to
/// WINNINGS only — `is_win` is false for a void refund, which is always returned in full, un-raked.
/// Pure rake split (unit-tested). Rake applies to WINNINGS only — a void refund (`is_win == false`) is
/// always returned in full, un-raked. Checked math; the fee can never exceed the gross.
fn rake_split(bps: u16, gross: u64, is_win: bool) -> Result<(u64, u64)> {
    if !is_win || bps == 0 { return Ok((gross, 0)); }
    let fee = ((gross as u128).checked_mul(bps as u128).ok_or(KernelError::Overflow)? / BPS_DENOM) as u64;
    Ok((gross - fee, fee))
}

fn apply_rake(config: &Account<Config>, gross: u64, is_win: bool) -> Result<(u64, u64)> {
    rake_split(config.rake_bps, gross, is_win)
}

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

    /// Initialise the singleton protocol Config (rake switch + fee recipient). Idempotent by PDA:
    /// callable once; the `init` constraint rejects a second call. Ships with `rake_bps = 0`.
    pub fn init_config(ctx: Context<InitConfig>, fee_recipient: Pubkey, rake_bps: u16) -> Result<()> {
        require!(rake_bps <= MAX_RAKE_BPS, KernelError::BadRake);
        let c = &mut ctx.accounts.config;
        c.authority = ctx.accounts.authority.key();
        c.fee_recipient = fee_recipient;
        c.rake_bps = rake_bps;
        c.bump = ctx.bumps.config;
        emit!(RakeSet { rake_bps, fee_recipient });
        Ok(())
    }

    /// Set the protocol rake and/or fee recipient. Authority-gated; hard-capped at `MAX_RAKE_BPS`
    /// in-program so the ceiling holds regardless of caller intent.
    pub fn set_rake(ctx: Context<SetRake>, rake_bps: u16, fee_recipient: Option<Pubkey>) -> Result<()> {
        require!(rake_bps <= MAX_RAKE_BPS, KernelError::BadRake);
        let c = &mut ctx.accounts.config;
        c.rake_bps = rake_bps;
        if let Some(fr) = fee_recipient { c.fee_recipient = fr; }
        emit!(RakeSet { rake_bps, fee_recipient: c.fee_recipient });
        Ok(())
    }

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

    /// Settle a market AGAINST its predicate: the thing was proven not to have happened, and NO takes
    /// the pot.
    ///
    /// Without this, a market has exactly two endings — YES wins, or everyone is refunded — and backing
    /// NO is strictly dominated: you lose your stake if the goal comes and you get it back if it doesn't.
    /// You can never profit. The pool was only ever one-sided, and every "back NO to win X" the app
    /// showed was a number it could not pay. That is the bug this closes.
    ///
    /// The asymmetry was never in the data, only in the kernel. `validate_stat` proves any comparison it
    /// is handed, so "it never happened" is as provable as "it did":
    ///
    ///     value(t) <= threshold   <=>   value(t) < threshold + 1        (Comparison::LessThan)
    ///
    /// with one binding that matters more than the arithmetic: **the snapshot must be taken after the
    /// market closed**. A proof that Spain had not scored by minute three is true and worthless. So `ts`
    /// must sit at or past `expiry_ts`, and the wall clock must be past `expiry_ts + VOID_GRACE_SECS` —
    /// the same head start `void` gives the keeper to land a rightful YES first, so the NO side cannot
    /// grief a winner by racing to settle the instant the window shuts.
    ///
    /// Nobody on NO? Then there is no rightful winner, and the pot is refunded rather than trapped —
    /// exactly as `settle` does when nobody is on YES.
    pub fn settle_no(
        ctx: Context<SettleNo>,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_a: StatTerm,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let m = &ctx.accounts.market;
            require!(m.status == STATUS_OPEN, KernelError::NotOpen);
            require_keys_eq!(ctx.accounts.txoracle_program.key(), TXORACLE_ID, KernelError::BadOracleProgram);
            require!(ctx.accounts.daily_scores_merkle_roots.to_account_info().owner == &TXORACLE_ID, KernelError::BadOracleProgram);
            require!(fixture_summary.fixture_id == m.fixture_id, KernelError::FixtureMismatch);
            require!(stat_a.stat_to_prove.key == m.stat_key, KernelError::StatMismatch);
            // Only over-threshold markets exist (v1), so "NO" is unambiguously `value <= threshold`.
            require!(m.comparison == COMPARISON_GREATER_THAN, KernelError::BadComparison);
            // The proof must describe the world AFTER the market shut. `ts` is milliseconds; expiry is seconds.
            require!(ts / 1000 >= m.expiry_ts, KernelError::SnapshotTooEarly);
            // And a rightful YES gets the first chance to land.
            let resolve_at = m.expiry_ts.checked_add(VOID_GRACE_SECS).ok_or(KernelError::Overflow)?;
            require!(now >= resolve_at, KernelError::NotExpired);
        }

        // value(t) <= threshold  <=>  value(t) < threshold + 1
        let predicate = TraderPredicate {
            threshold: ctx.accounts.market.threshold.checked_add(1).ok_or(KernelError::Overflow)?,
            comparison: Comparison::LessThan,
        };
        let txo = ctx.accounts.txoracle_program.to_account_info();
        let dsr = ctx.accounts.daily_scores_merkle_roots.to_account_info();
        let never_happened = prove_stat(&txo, &dsr, ts, fixture_summary, fixture_proof, main_tree_proof, predicate, stat_a, None, None)?;
        require!(never_happened, KernelError::PredicateNotMet);

        let m = &mut ctx.accounts.market;
        if m.no_total == 0 {
            // Proven false, but nobody backed NO: no rightful winner, so refund rather than trap the pot.
            m.status = STATUS_VOID;
            emit!(MarketVoided { market: m.key(), market_id: m.market_id });
        } else {
            m.status = STATUS_SETTLED_NO;
            m.settle_ts = ts;
            emit!(MarketSettled { market: m.key(), market_id: m.market_id, winning_side: SIDE_NO, ts });
        }
        Ok(())
    }

    /* ───────────────────────── K2 · the two-timestamp delta-proof market ─────────────────────────
     *
     * The Frozen Window asks a question the absolute-threshold market cannot: "does anyone score in the
     * NEXT ninety seconds?" — a change across a window, not a level. That is the only shape that makes a
     * suspension monetisable, and it is why the Freeze paid free points until now.
     *
     * `validate_stat` hands back a bool, never a value, so a delta cannot be read off-chain and trusted.
     * It can, however, be PROVEN. For any baseline `b` the settler picks:
     *
     *     value(t_a) <= b                     (proved: LessThan b+1  at t_a)
     *     value(t_b) >  b + delta - 1         (proved: GreaterThan b+delta-1 at t_b)
     *   ⇒ value(t_b) - value(t_a) >= delta
     *
     * The implication holds for EVERY b, so the settler cannot pick a convenient one: to make both
     * proofs pass they must actually have moved by `delta` across the window. The soccer stats are
     * monotone within a match, so the two snapshots order exactly as their timestamps do.
     *
     * A window lives in its own account attached to a market. The `Market` struct is untouched, so every
     * pool already holding money keeps its layout, its claims and its refunds.
     */

    /// Attach a window to an open market: the market's `threshold` becomes the DELTA that must occur
    /// between `start_ts` and the market's expiry. Only the market's authority may do this, and only
    /// before anyone has staked, so nobody's bet changes meaning underneath them.
    pub fn open_window(ctx: Context<OpenWindow>, start_ts: i64) -> Result<()> {
        let m = &ctx.accounts.market;
        require!(m.status == STATUS_OPEN, KernelError::NotOpen);
        require!(m.yes_total == 0 && m.no_total == 0, KernelError::WindowAfterStake);
        require!(m.comparison == 0, KernelError::BadComparison);           // delta is an over-threshold move
        require!(m.threshold > 0, KernelError::BadDelta);                  // a zero-delta window proves nothing
        require!(start_ts < m.expiry_ts, KernelError::BadExpiry);

        let w = &mut ctx.accounts.window;
        w.market = m.key();
        w.start_ts = start_ts;
        w.delta = m.threshold;
        w.baseline = 0;
        w.baseline_ts = 0;
        w.baseline_proven = false;
        w.bump = ctx.bumps.window;
        Ok(())
    }

    /// Step one: prove where the stat STOOD when the window opened, and bank it.
    ///
    /// Two Merkle proofs exceed Solana's 1232-byte transaction limit, so a window settles across two
    /// instructions. This one proves `value(t_a) <= baseline` for the settler's chosen baseline and
    /// records it. It decides nothing alone: a banked baseline is worthless without the second proof.
    #[allow(clippy::too_many_arguments)]
    pub fn prove_window_baseline(
        ctx: Context<ProveWindowBaseline>,
        baseline: i32,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_a: StatTerm,
    ) -> Result<()> {
        {
            let m = &ctx.accounts.market;
            let w = &ctx.accounts.window;
            require!(m.status == STATUS_OPEN, KernelError::NotOpen);
            require_keys_eq!(w.market, m.key(), KernelError::WindowMismatch);
            require!(fixture_summary.fixture_id == m.fixture_id, KernelError::FixtureMismatch);
            require!(stat_a.stat_to_prove.key == m.stat_key, KernelError::StatMismatch);
            require!(ts / 1000 >= w.start_ts, KernelError::WindowNotStarted);
            require!(ts / 1000 <= m.expiry_ts, KernelError::Expired);
        }

        // value(t_a) <= baseline   <=>   value(t_a) < baseline + 1
        let lo = TraderPredicate {
            threshold: baseline.checked_add(1).ok_or(KernelError::Overflow)?,
            comparison: Comparison::LessThan,
        };
        let txo = ctx.accounts.txoracle_program.to_account_info();
        let dsr = ctx.accounts.daily_scores_merkle_roots.to_account_info();
        let below = prove_stat(&txo, &dsr, ts, fixture_summary, fixture_proof, main_tree_proof, lo, stat_a, None, None)?;
        require!(below, KernelError::WindowBaselineNotProven);

        let w = &mut ctx.accounts.window;
        // Keep the TIGHTEST baseline ever proven. A smaller baseline is a stronger claim about where the
        // stat stood, so re-proving can only ratchet it down, never relax it into an easier settlement.
        if !w.baseline_proven || baseline < w.baseline {
            w.baseline = baseline;
            w.baseline_ts = ts;
        }
        w.baseline_proven = true;
        Ok(())
    }

    /// Step two: prove the stat MOVED by `delta` after the banked baseline, and pay.
    ///
    /// With `value(t_a) <= baseline` banked, proving `value(t_b) > baseline + delta - 1` forces
    /// `value(t_b) - value(t_a) >= delta`. The implication holds for EVERY baseline, so the settler's
    /// freedom to choose one buys them nothing.
    #[allow(clippy::too_many_arguments)]
    pub fn settle_window(
        ctx: Context<SettleWindow>,
        ts_b: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_b: StatTerm,
    ) -> Result<()> {
        let (baseline, delta) = {
            let m = &ctx.accounts.market;
            let w = &ctx.accounts.window;
            require!(m.status == STATUS_OPEN, KernelError::NotOpen);
            require_keys_eq!(w.market, m.key(), KernelError::WindowMismatch);
            require!(w.baseline_proven, KernelError::WindowBaselineNotProven);
            require!(fixture_summary.fixture_id == m.fixture_id, KernelError::FixtureMismatch);
            require!(stat_b.stat_to_prove.key == m.stat_key, KernelError::StatMismatch);
            require!(ts_b >= w.baseline_ts, KernelError::WindowOutOfOrder);
            require!(ts_b / 1000 <= m.expiry_ts, KernelError::Expired);
            (w.baseline, w.delta)
        };

        // value(t_b) >= baseline + delta   <=>   value(t_b) > baseline + delta - 1
        let hi_threshold = baseline
            .checked_add(delta).ok_or(KernelError::Overflow)?
            .checked_sub(1).ok_or(KernelError::Overflow)?;
        let hi = TraderPredicate { threshold: hi_threshold, comparison: Comparison::GreaterThan };

        let txo = ctx.accounts.txoracle_program.to_account_info();
        let dsr = ctx.accounts.daily_scores_merkle_roots.to_account_info();
        let moved = prove_stat(&txo, &dsr, ts_b, fixture_summary, fixture_proof, main_tree_proof, hi, stat_b, None, None)?;

        let m = &mut ctx.accounts.market;
        if moved {
            m.status = STATUS_SETTLED_YES;
            m.settle_ts = Clock::get()?.unix_timestamp;
            if m.yes_total == 0 { m.status = STATUS_VOID; }   // nobody to pay -> refund rather than trap
            emit!(MarketSettled { market: m.key(), market_id: m.market_id, winning_side: if m.status == STATUS_SETTLED_YES { SIDE_YES } else { 0 }, ts: m.settle_ts });
            Ok(())
        } else {
            err!(KernelError::PredicateNotMet)
        }
    }

    /// Void an unsettled market once it is past expiry + grace, enabling refunds. The grace window
    /// gives the keeper time to settle a within-window YES first, so a NO staker cannot void a
    /// rightful YES the instant expiry passes.
    /// The last resort: nobody could prove the stat either way, so nobody wins and everybody is repaid.
    ///
    /// This used to be reachable two minutes after expiry, which was harmless while a market's only
    /// endings were "YES wins" or "refund". Now that `settle_no` can pay the NO side, an early void is a
    /// way for the losing YES side to claw its stake back out of a pot NO had rightfully won. So voiding
    /// waits an hour: long enough that a healthy keeper — which settles within seconds of the oracle
    /// anchoring — will always have resolved the market first, and short enough that money is never
    /// trapped when the oracle genuinely has nothing to say.
    pub fn void(ctx: Context<Void>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        require!(m.status == STATUS_OPEN, KernelError::NotOpen);
        let void_at = m.expiry_ts.checked_add(RESOLVE_GRACE_SECS).ok_or(KernelError::Overflow)?;
        require!(now >= void_at, KernelError::NotExpired);
        m.status = STATUS_VOID;
        emit!(MarketVoided { market: m.key(), market_id: m.market_id });
        Ok(())
    }

    /// Claim winnings (settled-YES: pro-rata share of the whole pot) or a refund (voided: own stake).
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let (gross, is_win): (u64, bool) = {
            let m = &ctx.accounts.market;
            let pos = &ctx.accounts.position;
            require!(!pos.claimed, KernelError::AlreadyClaimed);
            match m.status {
                STATUS_SETTLED_YES => {
                    require!(pos.side == SIDE_YES, KernelError::NotWinner);
                    require!(m.yes_total > 0, KernelError::Overflow);
                    let pot = (m.yes_total as u128).checked_add(m.no_total as u128).ok_or(KernelError::Overflow)?;
                    ((pot.checked_mul(pos.amount as u128).ok_or(KernelError::Overflow)? / (m.yes_total as u128)) as u64, true)
                }
                STATUS_SETTLED_NO => {
                    // The mirror of the YES branch: the pot is split pro-rata across the NO side.
                    require!(pos.side == SIDE_NO, KernelError::NotWinner);
                    require!(m.no_total > 0, KernelError::Overflow);
                    let pot = (m.yes_total as u128).checked_add(m.no_total as u128).ok_or(KernelError::Overflow)?;
                    ((pot.checked_mul(pos.amount as u128).ok_or(KernelError::Overflow)? / (m.no_total as u128)) as u64, true)
                }
                STATUS_VOID => (pos.amount, false), // refund original stake (either side) — never raked
                _ => return err!(KernelError::NotResolved),
            }
        };
        // Commercial floor: skim the capped rake from winnings only (0 today). Refunds pass through whole.
        let (payout, fee) = apply_rake(&ctx.accounts.config, gross, is_win)?;

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
        if fee > 0 {
            invoke_signed(
                &system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.fee_recipient.key(), fee),
                &[ctx.accounts.vault.to_account_info(), ctx.accounts.fee_recipient.to_account_info(), ctx.accounts.system_program.to_account_info()],
                &[seeds],
            )?;
            emit!(FeeTaken { market: market_key, amount: fee, rake_bps: ctx.accounts.config.rake_bps });
        }

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
        let (gross, is_win): (u64, bool) = {
            let p = &ctx.accounts.parlay;
            let pos = &ctx.accounts.position;
            require!(!pos.claimed, KernelError::AlreadyClaimed);
            let pot = (p.yes_total as u128).checked_add(p.no_total as u128).ok_or(KernelError::Overflow)?;
            match p.status {
                STATUS_SETTLED_YES => {
                    require!(pos.side == SIDE_YES, KernelError::NotWinner);
                    require!(p.yes_total > 0, KernelError::Overflow);
                    ((pot.checked_mul(pos.amount as u128).ok_or(KernelError::Overflow)? / (p.yes_total as u128)) as u64, true)
                }
                STATUS_PARLAY_NO => {
                    require!(pos.side == SIDE_NO, KernelError::NotWinner);
                    require!(p.no_total > 0, KernelError::Overflow);
                    ((pot.checked_mul(pos.amount as u128).ok_or(KernelError::Overflow)? / (p.no_total as u128)) as u64, true)
                }
                STATUS_VOID => (pos.amount, false),
                _ => return err!(KernelError::NotResolved),
            }
        };
        let (payout, fee) = apply_rake(&ctx.accounts.config, gross, is_win)?;
        let pk = ctx.accounts.parlay.key();
        let vb = ctx.accounts.parlay.vault_bump;
        let seeds: &[&[u8]] = &[b"pvault", pk.as_ref(), &[vb]];
        invoke_signed(
            &system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.owner.key(), payout),
            &[ctx.accounts.vault.to_account_info(), ctx.accounts.owner.to_account_info(), ctx.accounts.system_program.to_account_info()],
            &[seeds],
        )?;
        if fee > 0 {
            invoke_signed(
                &system_instruction::transfer(&ctx.accounts.vault.key(), &ctx.accounts.fee_recipient.key(), fee),
                &[ctx.accounts.vault.to_account_info(), ctx.accounts.fee_recipient.to_account_info(), ctx.accounts.system_program.to_account_info()],
                &[seeds],
            )?;
            emit!(FeeTaken { market: pk, amount: fee, rake_bps: ctx.accounts.config.rake_bps });
        }
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
pub struct SettleNo<'info> {
    pub settler: Signer<'info>, // permissionless, exactly like `settle`
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: txoracle's daily_scores_roots PDA; owner-pinned in the handler, then read by validate_stat.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    /// CHECK: must be the txoracle program; enforced against TXORACLE_ID.
    pub txoracle_program: UncheckedAccount<'info>,
}

/// K2 — attach a window to a market. One window per market, PDA-derived from it.
#[derive(Accounts)]
pub struct OpenWindow<'info> {
    #[account(mut, address = market.authority @ KernelError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = authority, space = 8 + MarketWindow::INIT_SPACE,
              seeds = [b"window", market.key().as_ref()], bump)]
    pub window: Account<'info, MarketWindow>,
    pub system_program: Program<'info, System>,
}

/// K2 — bank the proven baseline. Permissionless: the proof decides, not the caller.
#[derive(Accounts)]
pub struct ProveWindowBaseline<'info> {
    pub settler: Signer<'info>,
    #[account(seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"window", market.key().as_ref()], bump = window.bump)]
    pub window: Account<'info, MarketWindow>,
    /// CHECK: txoracle's daily_scores_roots PDA; owner-pinned to TXORACLE_ID inside prove_stat.
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    /// CHECK: must be the txoracle program; enforced against TXORACLE_ID.
    pub txoracle_program: UncheckedAccount<'info>,
}

/// K2 — settle a window market. Permissionless, like every other crank: the proofs decide, not the caller.
#[derive(Accounts)]
pub struct SettleWindow<'info> {
    pub settler: Signer<'info>,
    #[account(mut, seeds = [b"market", market.market_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(seeds = [b"window", market.key().as_ref()], bump = window.bump)]
    pub window: Account<'info, MarketWindow>,
    /// CHECK: txoracle's daily_scores_roots PDA; owner-pinned to TXORACLE_ID inside prove_stat.
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
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: house fee recipient, pinned to config.fee_recipient; only ever receives the rake slice.
    #[account(mut, address = config.fee_recipient @ KernelError::BadFeeRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,
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
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: house fee recipient, pinned to config.fee_recipient; only ever receives the rake slice.
    #[account(mut, address = config.fee_recipient @ KernelError::BadFeeRecipient)]
    pub fee_recipient: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRake<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = authority @ KernelError::NotConfigAuthority)]
    pub config: Account<'info, Config>,
}

// ───────────────────────── state ─────────────────────────
/// K2 — a window attached to a market. Kept OUT of `Market` on purpose: adding a field to a live
/// account type would change its size, and every pool currently holding money would stop deserialising.
#[account]
#[derive(InitSpace)]
pub struct MarketWindow {
    pub market: Pubkey,
    pub start_ts: i64,        // unix seconds; the baseline snapshot must be at or after this
    pub delta: i32,           // how much the stat must move across the window for YES
    // Two Merkle proofs do not fit in one Solana transaction (1232 bytes), so the baseline is proven
    // and BANKED first, in its own instruction, and settlement then carries only the second proof.
    pub baseline: i32,
    pub baseline_ts: i64,     // milliseconds, as the proof reports it
    pub baseline_proven: bool,
    pub bump: u8,
}

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

/// Singleton protocol config — the commercial-floor switch. One PDA (seeds = [b"config"]) for the
/// whole program; read by every claim to know today's rake (0) and where the house fee goes.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,     // may change the rake / recipient
    pub fee_recipient: Pubkey, // where the rake accrues (the house treasury)
    pub rake_bps: u16,         // current protocol rake, ≤ MAX_RAKE_BPS (0 today)
    pub bump: u8,
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
#[event]
pub struct FeeTaken { pub market: Pubkey, pub amount: u64, pub rake_bps: u16 }
#[event]
pub struct RakeSet { pub rake_bps: u16, pub fee_recipient: Pubkey }

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
    #[msg("A window cannot be attached after someone has staked")] WindowAfterStake,
    #[msg("A window needs a delta greater than zero")] BadDelta,
    #[msg("That window belongs to another market")] WindowMismatch,
    #[msg("The two snapshots are out of order")] WindowOutOfOrder,
    #[msg("The earlier snapshot predates the window")] WindowNotStarted,
    #[msg("The baseline was not proven at the window's start")] WindowBaselineNotProven,
    #[msg("Only the market authority can do that")] Unauthorized,
    #[msg("Proof snapshot is after the market window (ts > expiry)")] Expired,
    #[msg("Only GreaterThan (monotone over-threshold) markets are supported in v1")] OnlyGreaterThan,
    #[msg("Expiry must be in the future")] BadExpiry,
    #[msg("Lock must be in the future and no later than expiry")] BadLock,
    #[msg("Pool is locked — no new calls after the cut-off")] PoolLocked,
    #[msg("validate_stat returned no verdict")] NoVerdict,
    #[msg("Predicate not met — not settleable yet")] PredicateNotMet,
    #[msg("Market not yet expired")] NotExpired,
    #[msg("The proof predates the market's close")] SnapshotTooEarly,
    #[msg("Already claimed")] AlreadyClaimed,
    #[msg("Caller is not on the winning side")] NotWinner,
    #[msg("Market not resolved")] NotResolved,
    #[msg("Invalid parlay legs")] BadLegs,
    #[msg("Rake exceeds the hard cap")] BadRake,
    #[msg("Fee recipient does not match config")] BadFeeRecipient,
    #[msg("Caller is not the config authority")] NotConfigAuthority,
}

// ── Unit tests (host target — `cargo test -p latch --lib`, no validator/RPC needed). Covers the pure,
// deterministic settlement helpers; the CPI + end-to-end paths are exercised by ../../src/*e2e.ts on devnet.
#[cfg(test)]
mod tests {
    use super::*;

    /// The K2 reduction, as pure arithmetic. `lo`/`hi` are the two predicate thresholds the kernel
    /// derives from the settler's chosen baseline; `window_yes` says whether both proofs can pass.
    fn lo_threshold(baseline: i32) -> i32 { baseline + 1 }
    fn hi_threshold(baseline: i32, delta: i32) -> i32 { baseline + delta - 1 }
    /// Both CPIs pass iff value_a < lo AND value_b > hi.
    fn window_yes(value_a: i32, value_b: i32, baseline: i32, delta: i32) -> bool {
        value_a < lo_threshold(baseline) && value_b > hi_threshold(baseline, delta)
    }

    #[test]
    fn window_proof_implies_the_delta_for_every_baseline() {
        // If both proofs pass, the move really was at least `delta` — whatever baseline was chosen.
        for delta in 1..4 {
            for baseline in -2..6 {
                for a in 0..6 {
                    for b in 0..8 {
                        if window_yes(a, b, baseline, delta) {
                            assert!(b - a >= delta, "b={} a={} baseline={} delta={}", b, a, baseline, delta);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn a_real_move_is_always_provable_by_some_baseline() {
        // And the honest settler can always find one: b = value_a.
        for delta in 1..4 {
            for a in 0..6 {
                let b = a + delta;
                assert!(window_yes(a, b, a, delta), "a={} b={} delta={}", a, b, delta);
            }
        }
    }

    #[test]
    fn a_move_that_did_not_happen_cannot_be_proven_by_any_baseline() {
        // One short of the delta: no baseline in a wide range makes both proofs pass.
        for delta in 1..4 {
            for a in 0..6 {
                let b = a + delta - 1;
                for baseline in -8..12 {
                    assert!(!window_yes(a, b, baseline, delta), "a={} b={} baseline={} delta={}", a, b, baseline, delta);
                }
            }
        }
    }

    #[test]
    fn a_goal_before_the_window_does_not_count() {
        // The window opened at a=1 (a goal already on the board). Nothing more is scored: b stays 1.
        assert!(!window_yes(1, 1, 1, 1));
        // One is then scored inside the window.
        assert!(window_yes(1, 2, 1, 1));
    }

    #[test]
    fn comparison_from_u8_maps_the_three_valid_codes() {
        assert!(matches!(comparison_from_u8(0).unwrap(), Comparison::GreaterThan));
        assert!(matches!(comparison_from_u8(1).unwrap(), Comparison::LessThan));
        assert!(matches!(comparison_from_u8(2).unwrap(), Comparison::EqualTo));
    }

    #[test]
    fn comparison_from_u8_rejects_out_of_range() {
        assert!(comparison_from_u8(3).is_err());
        assert!(comparison_from_u8(255).is_err());
    }

    #[test]
    fn rake_applies_to_winnings_only_and_is_capped() {
        // 5% (the MAX_RAKE_BPS ceiling) on 1000 → 50 fee, 950 to the winner.
        assert_eq!(rake_split(500, 1000, true).unwrap(), (950, 50));
        // A void refund is never raked — the fan gets the whole stake back.
        assert_eq!(rake_split(500, 1000, false).unwrap(), (1000, 0));
        // Zero rake → whole pot to the winner.
        assert_eq!(rake_split(0, 1000, true).unwrap(), (1000, 0));
        // The fee never exceeds the gross, even at the hard ceiling on a large pot.
        let (net, fee) = rake_split(MAX_RAKE_BPS, u64::MAX / 2, true).unwrap();
        assert!(fee <= u64::MAX / 2 && net + fee == u64::MAX / 2);
    }

    /* ── settle_no · the side that could never win ─────────────────────────────────────────────── */

    /// The pro-rata split, as `claim` computes it for each winning side.
    fn share(pot: u128, mine: u64, side_total: u64) -> u64 {
        ((pot * mine as u128) / side_total as u128) as u64
    }

    #[test]
    fn no_side_takes_the_whole_pot_when_the_predicate_is_proven_false() {
        // The exact shape of a seeded pool: 0.02 on YES, 0.06 on NO.
        let (yes, no) = (20_000_000u64, 60_000_000u64);
        let pot = (yes + no) as u128;
        // Nobody scored: NO wins, and a lone NO backer takes everything, including the YES stake.
        assert_eq!(share(pot, no, no), yes + no);
        // Two NO backers split it in proportion to their stakes. Pro-rata truncates, so the pot may
        // retain at most one lamport of dust per winner beyond the first — the same rounding the YES
        // side has always had. It is never over-paid, which is the property that matters.
        let paid = share(pot, 20_000_000, no) + share(pot, 40_000_000, no);
        assert!(paid <= yes + no, "the vault can never pay out more than the pot");
        assert!((yes + no) - paid <= 1, "and the dust left behind is at most a lamport");
    }

    #[test]
    fn the_two_sides_are_now_symmetric() {
        let (yes, no) = (30_000_000u64, 50_000_000u64);
        let pot = (yes + no) as u128;
        // Whichever side is proven, that side splits the same pot the same way.
        assert_eq!(share(pot, yes, yes), yes + no);
        assert_eq!(share(pot, no, no), yes + no);
    }

    #[test]
    fn backing_no_can_now_profit_where_before_it_could_only_break_even() {
        let (yes, no) = (60_000_000u64, 20_000_000u64);
        let pot = (yes + no) as u128;
        let stake = no;                       // a lone NO backer
        let before = stake;                   // old kernel: VOID -> refund, exactly the stake
        let after = share(pot, stake, no);    // new kernel: SETTLED_NO -> the pot
        assert_eq!(before, 20_000_000);
        assert_eq!(after, 80_000_000);
        assert!(after > before, "NO must be able to win, not merely be repaid");
    }

    #[test]
    fn no_is_proven_by_the_strict_less_than_of_threshold_plus_one() {
        // The kernel asks validate_stat for `value < threshold + 1`, which is exactly `value <= threshold`.
        let holds = |value: i32, threshold: i32| value < threshold + 1;
        // "Belgium to score" (threshold 0), final 0 goals -> NO is true.
        assert!(holds(0, 0));
        // ...and one goal makes it false, so settle_no cannot steal a market YES already won.
        assert!(!holds(1, 0));
        // "3+ goals" (threshold 2): two goals still means NO.
        assert!(holds(2, 2));
        assert!(!holds(3, 2));
    }

    #[test]
    fn a_void_can_no_longer_grief_a_rightful_no_winner() {
        let expiry = 1_000_000i64;
        // settle_no opens at expiry + VOID_GRACE_SECS; void only at expiry + RESOLVE_GRACE_SECS.
        let settle_no_at = expiry + VOID_GRACE_SECS;
        let void_at = expiry + RESOLVE_GRACE_SECS;
        assert!(settle_no_at < void_at, "the keeper must be able to resolve before anyone may void");
        // The old kernel voided at the same instant NO became provable — a free claw-back for the loser.
        assert_eq!(settle_no_at, expiry + 120);
        assert_eq!(void_at, expiry + 3600);
    }

    #[test]
    fn a_snapshot_from_before_the_close_cannot_settle_no() {
        // `ts` is milliseconds, `expiry_ts` is seconds. "Spain hadn't scored by minute 3" is true and
        // worthless; only a snapshot at or after the close may resolve the market against the predicate.
        let expiry_secs = 1_800_000i64;
        let too_early_ms = (expiry_secs - 1) * 1000;
        let ok_ms = expiry_secs * 1000;
        assert!(too_early_ms / 1000 < expiry_secs);
        assert!(ok_ms / 1000 >= expiry_secs);
    }
}
