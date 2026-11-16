// Token Radar model: turns the frozen DefiLlama snapshot into a ranked board
// of pre-token protocols, each with an implied token value derived from the
// snapshot's own figures and a concrete plan for farming it.
//
// Nothing here is a per-name judgement. Every number on the board comes out of
// one formula whose coefficients are either fixed model constants (below) or
// statistics computed from the snapshot at run time — most importantly the
// category multiples, which are the median market-cap/TVL ratios of the
// protocols in the snapshot that already have a token. Run the same snapshot
// in, get the same board out: no clock, no randomness, no network.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** The model's fixed constants. Everything else is derived from the data. */
export const MODEL = {
  /** Category multiples are clamped into this band. */
  multipleFloor: 0.02,
  multipleCap: 3.0,
  /** A category needs at least this many tokenized peers to speak for itself. */
  minPeers: 4,
  /** Weekly TVL change (per cent) is clamped into this band before use. */
  momentumClampLo: -60,
  momentumClampHi: 120,
  /** momentum = max(momentumFloor, 1 + momentumWeight * g / 100). */
  momentumWeight: 0.5,
  momentumFloor: 0.5,
  /** maturity = base + gain * sqrt(min(ageYears, ageCap) / ageCap). */
  maturityBase: 0.75,
  maturityGain: 0.25,
  maturityAgeCapYears: 5,
  /** Protocols with no listing date get this neutral-low maturity. */
  maturityUnknown: 0.8,
  /** breadth = 1 + perChain * min(extraChains, maxExtraChains). */
  breadthPerChain: 0.03,
  breadthMaxExtraChains: 7,
} as const;

export interface CategoryMultiple {
  category: string;
  /** The multiple actually used (after fallback and clamping). */
  multiple: number;
  /** The raw median mcap/TVL of the category's tokenized peers, before clamping. */
  rawMedian: number | null;
  /** How many tokenized peers with both figures fed the median. */
  peers: number;
  /** 'category' when the category's own peers set the multiple, else 'global'. */
  source: 'category' | 'global';
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  implied_value_usd: number;
  multiple: number;
  /** Whether the multiple came from the category's own peers or the global fallback. */
  multiple_source: 'category' | 'global';
  momentum: number;
  maturity: number;
  breadth: number;
  peers: number;
  signal: number;
  watchlist: boolean;
  farm_steps: string[];
}

export interface RadarData {
  meta: {
    as_of: string;
    source: string;
    floor_usd: number;
    protocols_total: number;
    pre_token_count: number;
    watchlist_count: number;
    tokenized_count: number;
  };
  model: {
    constants: typeof MODEL;
    global_multiple: number;
    global_peers: number;
    categories: CategoryMultiple[];
  };
  rows: BoardRow[];
  live: {
    count: number;
    examples: { name: string; symbol: string | null; mcap_usd: number | null }[];
  };
}

const isPreToken = (p: Protocol): boolean => p.gecko_id === null && p.symbol === null;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Median of an already-sorted list; null for an empty one. */
function medianOfSorted(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The category multiples: for every category, the median market-cap/TVL of
 * the snapshot's tokenized protocols in it. Categories with too few peers
 * fall back to the global tokenized median. All values clamped to the band.
 */
export function categoryMultiples(snapshot: Snapshot): { global: CategoryMultiple; byCategory: Map<string, CategoryMultiple> } {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    allRatios.push(ratio);
    if (p.category !== null) {
      const list = ratiosByCategory.get(p.category);
      if (list) list.push(ratio);
      else ratiosByCategory.set(p.category, [ratio]);
    }
  }
  allRatios.sort((a, b) => a - b);
  const globalMedian = medianOfSorted(allRatios) ?? 1;
  const global: CategoryMultiple = {
    category: '(all categories)',
    multiple: clamp(globalMedian, MODEL.multipleFloor, MODEL.multipleCap),
    rawMedian: globalMedian,
    peers: allRatios.length,
    source: 'global',
  };
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, ratios] of ratiosByCategory) {
    ratios.sort((a, b) => a - b);
    const med = medianOfSorted(ratios)!;
    if (ratios.length >= MODEL.minPeers) {
      byCategory.set(category, {
        category,
        multiple: clamp(med, MODEL.multipleFloor, MODEL.multipleCap),
        rawMedian: med,
        peers: ratios.length,
        source: 'category',
      });
    } else {
      byCategory.set(category, {
        category,
        multiple: global.multiple,
        rawMedian: med,
        peers: ratios.length,
        source: 'global',
      });
    }
  }
  return { global, byCategory };
}

/** Whole days between two YYYY-MM-DD dates, parsed as UTC. */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.floor(ms / 86_400_000);
}

/** The four factors of one pre-token protocol. */
export function factorsOf(
  p: Protocol,
  asOf: string,
  multiples: { global: CategoryMultiple; byCategory: Map<string, CategoryMultiple> },
): { multiple: number; multiple_source: 'category' | 'global'; momentum: number; maturity: number; breadth: number; peers: number } {
  const entry = p.category !== null ? multiples.byCategory.get(p.category) : undefined;
  const multiple = entry ? entry.multiple : multiples.global.multiple;
  const multiple_source = entry ? entry.source : 'global';
  const peers = entry ? entry.peers : multiples.global.peers;

  let momentum = 1;
  if (p.change_7d !== null) {
    const g = clamp(p.change_7d, MODEL.momentumClampLo, MODEL.momentumClampHi);
    momentum = Math.max(MODEL.momentumFloor, 1 + (MODEL.momentumWeight * g) / 100);
  }

  let maturity = MODEL.maturityUnknown;
  if (p.listed_at !== null) {
    const ageYears = Math.max(0, daysBetween(p.listed_at, asOf)) / 365.25;
    const t = Math.min(ageYears, MODEL.maturityAgeCapYears) / MODEL.maturityAgeCapYears;
    maturity = MODEL.maturityBase + MODEL.maturityGain * Math.sqrt(t);
  }

  const extraChains = Math.max(0, p.chains.length - 1);
  const breadth = 1 + MODEL.breadthPerChain * Math.min(extraChains, MODEL.breadthMaxExtraChains);

  return { multiple, multiple_source, momentum, maturity, breadth, peers };
}

// ---------------------------------------------------------------- farm plans
//
// A farm plan is five concrete steps built from the protocol's category
// family, its first chain and its size tier. Every step names an action, an
// amount of money and an amount of time, because "be active" is not a plan.

interface FarmCtx {
  name: string;
  cat: string;
  chain: string;
  chain2: string | null;
  pos: string;
  costPhrase: string;
  mins: string;
  tvl: string;
}

/** $1,234,567 style grouping, done by hand so it never depends on ICU data. */
export function fmtUsd(n: number): string {
  const digits = String(Math.max(0, Math.round(n)));
  return '$' + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const L2_CHAINS = new Set([
  'Arbitrum', 'Base', 'Optimism', 'Linea', 'Scroll', 'zkSync Era', 'Mantle',
  'Mode', 'Blast', 'Taiko', 'Starknet', 'Zora', 'Fraxtal', 'Soneium',
]);

function costPhraseFor(chain: string): string {
  if (chain === 'Ethereum') return 'about $24 in mainnet gas for the round trip';
  if (chain === 'Solana') return 'about $0.10 in network fees for the round trip';
  if (L2_CHAINS.has(chain)) return 'about $1.20 in L2 gas for the round trip';
  return 'about $4 in network fees for the round trip';
}

/** Size tiers: bigger protocols can absorb — and reward — a bigger position. */
function tierOf(tvl: number): { pos: string; mins: string } {
  if (tvl < 10_000_000) return { pos: '$250', mins: '20 minutes' };
  if (tvl < 50_000_000) return { pos: '$500', mins: '30 minutes' };
  if (tvl < 250_000_000) return { pos: '$1,000', mins: '40 minutes' };
  return { pos: '$2,500', mins: '50 minutes' };
}

function farmCtx(p: Protocol): FarmCtx {
  const tier = tierOf(p.tvl_usd);
  const chain = p.chains[0] ?? 'Ethereum';
  return {
    name: p.name,
    cat: p.category ?? 'DeFi',
    chain,
    chain2: p.chains.length > 1 ? p.chains[1]! : null,
    pos: tier.pos,
    costPhrase: costPhraseFor(chain),
    mins: tier.mins,
    tvl: fmtUsd(p.tvl_usd),
  };
}

type StepFn = (c: FarmCtx) => string;

/** Steps shared by every family: open the position's paperwork, then review it. */
const stepTrack: StepFn = (c) =>
  `Keep a farming log for ${c.name}: after each session note the date, the action and your balance, and check the protocol's points or season page if it runs one. Ten minutes a week of records is what lets you prove a Sybil review wrong and size up before a snapshot.`;
const stepReview: StepFn = (c) =>
  `Review the position monthly, about 30 minutes: confirm ${c.name} still records no token, re-check its TVL trend, and be ready to unwind within a week if a launch is announced with a snapshot already taken. Keep claim pages bookmarked so a distribution is a 5-minute job, not a scramble.`;

const FAMILIES: Record<string, StepFn[]> = {
  dexs: [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} plus gas money; swapping through ${c.name} costs ${c.costPhrase}. Use a fresh address you control the keys to, and keep the seed phrase offline.`,
    (c) => `Make your first swaps on ${c.name}: trade ${c.pos} across its main pairs in 3 or 4 transactions of uneven size rather than one block, so the activity reads as trading, not wash volume. Budget 15 minutes for the session.`,
    (c) => `Add a small liquidity position beside your swaps: deposit ${c.pos} split evenly across a pair on ${c.name} and leave it at least a month, since LPs who stay through a full season are the ones points programs remember.`,
    (c) => `Repeat the swap session weekly, about ${c.mins}: vary the pairs and amounts, keep total fees under 1% of the position, and stop adding volume if the protocol's TVL starts sliding two weeks in a row.`,
    stepReview,
  ],
  lending: [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} plus gas money; a supply-and-borrow round trip on ${c.name} costs ${c.costPhrase}. Keep a separate address for lending so the position is easy to track.`,
    (c) => `Supply ${c.pos} of a mainstream asset (ETH or a major stablecoin) to ${c.name} as your first position, then borrow back at most 30% of it and re-supply the borrowed amount once, so both sides of the market see your address.`,
    (c) => `Hold the loop for at least 8 weeks: check your health factor twice a week, about 5 minutes each time, and keep it above 1.6 so a volatile week cannot liquidate the position you are farming.`,
    (c) => `Refresh the position weekly, about ${c.mins}: repay and re-borrow a small slice, or top the supply up by 5%, so the address shows continuing use rather than one deposit left to rot.`,
    stepReview,
  ],
  'liquid-staking': [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} in the chain's native asset plus gas money; staking through ${c.name} costs ${c.costPhrase}.`,
    (c) => `Stake ${c.pos} through ${c.name} and hold the liquid staking token you receive in the same wallet; an unstaked or instantly sold receipt is the pattern points programs discount.`,
    (c) => `Put half the staking receipt to work in one conservative place — a lending market or a stable pair — so the position earns its keep while it waits, and keep the other half liquid for a fast exit.`,
    (c) => `Add to the stake monthly, about ${c.mins} of work: even a 5% top-up each month builds the long, steady history that launch allocations tend to reward over one large deposit.`,
    stepReview,
  ],
  'liquid-restaking': [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} in ETH or a liquid staking token plus gas money; restaking through ${c.name} costs ${c.costPhrase}.`,
    (c) => `Restake ${c.pos} through ${c.name} and record the points rate you start at; restaking points usually stack with the underlying staking yield, so note both in your log from day one.`,
    (c) => `Split the position if you can: restake two-thirds directly and route one-third through a partner pool, so a change in either program's rules does not zero out the whole farm.`,
    (c) => `Check the position weekly, about ${c.mins}: restaking carries slashing and withdrawal-queue risk, so confirm the exit window and queue length still suit a position you may need to unwind in days, not months.`,
    stepReview,
  ],
  bridge: [
    (c) => `Set up wallets on ${c.chain} and one destination chain, and fund the origin with ${c.pos} plus gas money; a crossing through ${c.name} costs ${c.costPhrase}.`,
    (c) => `Bridge ${c.pos} through ${c.name} to the destination chain, then bridge a smaller amount back a few days later; two genuine crossings a month beat twenty frantic ones for any volume-or-count scoring.`,
    (c) => `Use the bridged funds where they land: make one real transaction on the destination chain — a swap or a deposit — so the trip reads as use of the ecosystem, not a round trip for its own sake.`,
    (c) => `Repeat monthly, about ${c.mins} per session: rotate destination chains${c.chain2 ? `, including ${c.chain2},` : ''} keep each crossing under your weekly budget, and log every transaction hash for later proof.`,
    stepReview,
  ],
  'canonical-bridge': [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} plus gas money; bridging into the chain through ${c.name} costs ${c.costPhrase}.`,
    (c) => `Bridge ${c.pos} into the chain through ${c.name} and leave the funds working there at least a month: canonical bridges feed a chain's own launch case, and balances that stay are the metric that matters.`,
    (c) => `Deploy the bridged funds inside the ecosystem: supply or swap half of them on the chain's main lending market or exchange, so your address holds both a bridge record and local activity.`,
    (c) => `Top the balance up monthly, about ${c.mins}: grow the position by 5–10% rather than bridging one lump sum, and never bridge back to ${c.chain} in the same week you bridge in.`,
    stepReview,
  ],
  yield: [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} plus gas money; entering a vault on ${c.name} costs ${c.costPhrase}.`,
    (c) => `Deposit ${c.pos} into ${c.name}'s flagship vault or pool — the one holding most of its ${c.tvl} TVL — since flagship vaults are where a future token's loyalty accounting usually starts.`,
    (c) => `Harvest and re-deposit rewards monthly rather than selling them: a compounding depositor is visibly different from a mercenary one, and the extra yield costs you only ${c.mins} a month.`,
    (c) => `Re-check the vault's strategy quarterly, about 30 minutes: read what the vault actually holds, and move to a safer vault or out entirely if the underlying assets stop being ones you can name.`,
    stepReview,
  ],
  derivatives: [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} plus gas money; funding an account on ${c.name} costs ${c.costPhrase}. Treat the whole amount as tuition: derivatives farms are paid for in fees and liquidations.`,
    (c) => `Open your first trades small: risk at most 2% of the account per position, trade the most liquid market on ${c.name}, and close every position the same week so your record shows completed trades, not one open gamble.`,
    (c) => `Trade on a schedule, about ${c.mins} a week: two or three modest sessions beat one huge one, and steady fee-paying flow is exactly the behaviour a pre-token exchange wants to reward at launch.`,
    (c) => `Cap your losses in writing before each month starts: if the account is down 20%, halve position sizes; if it is down 35%, stop trading and keep only the history you have already earned.`,
    stepReview,
  ],
  cdp: [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} in a mainstream collateral asset plus gas money; opening a vault on ${c.name} costs ${c.costPhrase}.`,
    (c) => `Open a vault on ${c.name}: deposit ${c.pos} of collateral and mint its stablecoin at no more than half the maximum the collateral allows, so the position survives a 30% market drop without liquidation.`,
    (c) => `Use the minted stablecoin once — supply it to a lending market or a stable pool — so your address shows both sides of the protocol: collateral locked and debt in circulation.`,
    (c) => `Check the vault weekly, about ${c.mins}: top collateral up if the ratio drifts toward the liquidation line, and repay a slice monthly so the debt balance shows a living borrower, not a forgotten one.`,
    stepReview,
  ],
  rwa: [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} plus gas money; entering a product on ${c.name} costs ${c.costPhrase}. Complete any KYC the platform asks for early — unverified accounts are usually ineligible for distributions.`,
    (c) => `Buy ${c.pos} of ${c.name}'s most-held real-world asset product — the one carrying most of its ${c.tvl} TVL — and hold it; RWA positions are slow by design, and short holds read as tourism.`,
    (c) => `Claim or reinvest every distribution the product pays, on schedule: an investor who interacts at each payment date builds the exact history a token launch would reward.`,
    (c) => `Review the position quarterly, about 30 minutes: read the issuer's latest attestation or reserve report, and exit any product whose reporting goes stale, whatever the yield.`,
    stepReview,
  ],
  cex: [
    (c) => `Open an account on ${c.name} and complete full KYC on day one — exchange token distributions almost always require a verified account with a trading history, and verification can take days when a launch is announced.`,
    (c) => `Deposit ${c.pos} and make your first spot trades across its main pairs; keep individual trades modest and spread over days, since one deposit-and-dump is the pattern exchange campaigns exclude.`,
    (c) => `Use one product beyond spot — a simple earn vault or a small recurring buy — so the account shows breadth; set the recurring buy to run weekly and forget it, about ${c.mins} to set up.`,
    (c) => `Keep a steady monthly volume rather than a single burst, and hold a small balance on the exchange between sessions; dormant-but-funded accounts are the ones snapshot-based drops tend to include.`,
    stepReview,
  ],
  'risk-curators': [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} plus gas money; depositing into a vault curated through ${c.name} costs ${c.costPhrase}.`,
    (c) => `Deposit ${c.pos} into the largest vault ${c.name} curates, after reading its allocation list once — you are trusting the curator's judgement, so spend 20 minutes knowing what you own before the money moves.`,
    (c) => `Spread a second, smaller deposit across one more of its vaults on a different asset, so your address appears in more than one of the curator's books.`,
    (c) => `Re-read the vault allocations monthly, about ${c.mins}: curators rebalance quietly, and your monthly check is what catches a drift into assets you would not have chosen yourself.`,
    stepReview,
  ],
  allocator: [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} plus gas money; depositing through ${c.name} costs ${c.costPhrase}.`,
    (c) => `Deposit ${c.pos} into ${c.name}'s main allocation product and leave it a full quarter: capital allocators reward duration above almost everything, because their own strategies need stable funding.`,
    (c) => `Turn on auto-compounding if the product offers it, and claim every distribution it pays rather than letting rewards sit unclaimed — unclaimed rewards are invisible in most loyalty accounting.`,
    (c) => `Add funds on a monthly rhythm, about ${c.mins} of work: four equal monthly deposits build a better record than the same money arriving in one lump, and they average your entry across market conditions.`,
    stepReview,
  ],
  'leveraged-farming': [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} plus gas money; opening a leveraged position on ${c.name} costs ${c.costPhrase}. Only farm with money whose total loss would annoy you, not harm you.`,
    (c) => `Open a conservative position on ${c.name}: borrow against ${c.pos} of collateral at no more than 2x effective leverage, in a pair whose two sides move together, so ordinary volatility cannot liquidate you.`,
    (c) => `Check the position twice a week, about 10 minutes each time: leverage farms fail silently, and a position checked on schedule can be topped up or closed in minutes instead of discovered liquidated.`,
    (c) => `Harvest rewards monthly and take them off the position rather than compounding into more leverage; the farm's edge is the reward stream, not an ever-growing stack of borrowed risk.`,
    stepReview,
  ],
  generic: [
    (c) => `Set up a wallet on ${c.chain} and fund it with ${c.pos} plus gas money; a first round trip through ${c.name} costs ${c.costPhrase}. Read its documentation's main flow once before sending funds.`,
    (c) => `Make your first real use of ${c.name}: put ${c.pos} through its core product — the flow that carries most of its ${c.tvl} TVL — and complete the full cycle once, deposit to withdrawal or start to finish, so you know the exit works.`,
    (c) => `Return weekly, about ${c.mins}: repeat the core action at modest size, vary amounts and times of day, and keep total fees under 1% of the position per month.`,
    stepTrack,
    stepReview,
  ],
};

/** Category → farm-plan family. Aliases fold neighbouring categories in. */
const FAMILY_BY_CATEGORY: Record<string, string> = {
  Dexs: 'dexs',
  Lending: 'lending',
  'Uncollateralized Lending': 'lending',
  'Liquid Staking': 'liquid-staking',
  'Staking Pool': 'liquid-staking',
  'Liquid Restaking': 'liquid-restaking',
  Restaking: 'liquid-restaking',
  'Restaked BTC': 'liquid-restaking',
  Bridge: 'bridge',
  'Cross Chain Bridge': 'bridge',
  'Canonical Bridge': 'canonical-bridge',
  Yield: 'yield',
  'Yield Aggregator': 'yield',
  Farm: 'yield',
  Derivatives: 'derivatives',
  Options: 'derivatives',
  'Options Vault': 'derivatives',
  'Interest Rate Derivatives': 'derivatives',
  CDP: 'cdp',
  'CDP Manager': 'cdp',
  'Algo-Stables': 'cdp',
  'Dual-Token Stablecoin': 'cdp',
  RWA: 'rwa',
  CEX: 'cex',
  'Risk Curators': 'risk-curators',
  'Onchain Capital Allocator': 'allocator',
  'Liquidity Manager': 'allocator',
  'Basis Trading': 'allocator',
  'Collateral Management': 'allocator',
  'Leveraged Farming': 'leveraged-farming',
};

/** The five-step farm plan for one protocol, each step 20–600 characters. */
export function farmSteps(p: Protocol): string[] {
  const family = (p.category !== null && FAMILY_BY_CATEGORY[p.category]) || 'generic';
  const steps = FAMILIES[family]!.map((fn) => fn(farmCtx(p)));
  for (const s of steps) {
    const len = s.trim().length;
    if (len < 20 || len > 600) throw new Error(`farm step for ${p.slug} is ${len} chars, outside 20..600`);
  }
  return steps;
}

// ---------------------------------------------------------------- the board

/** A 0–100 signal: half the (log-scaled) value, half the quality factors. */
function signalOf(implied: number, maxImplied: number, f: { multiple: number; momentum: number; maturity: number }): number {
  const valueScore = maxImplied > 1 ? Math.log10(Math.max(1, implied)) / Math.log10(maxImplied) : 1;
  const momScore = clamp((f.momentum - MODEL.momentumFloor) / (1.6 - MODEL.momentumFloor), 0, 1);
  const matScore = clamp((f.maturity - MODEL.maturityBase) / MODEL.maturityGain, 0, 1);
  const multScore = clamp(
    (Math.log10(Math.max(MODEL.multipleFloor, f.multiple)) - Math.log10(MODEL.multipleFloor)) /
      (Math.log10(MODEL.multipleCap) - Math.log10(MODEL.multipleFloor)),
    0,
    1,
  );
  return Math.round(100 * (0.5 * valueScore + 0.2 * momScore + 0.15 * matScore + 0.15 * multScore));
}

/** Build the full radar payload: board rows plus everything the page shows. */
export function buildRadar(snapshot: Snapshot): RadarData {
  const multiples = categoryMultiples(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const pre = snapshot.protocols.filter(isPreToken);

  const scored = pre.map((p) => {
    const f = factorsOf(p, snapshot.as_of, multiples);
    const implied = Math.max(1, Math.round(p.tvl_usd * f.multiple * f.momentum * f.maturity * f.breadth));
    return { p, f, implied };
  });
  scored.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const maxImplied = scored.length > 0 ? scored[0]!.implied : 1;
  const rows: BoardRow[] = [];
  let prev = Number.POSITIVE_INFINITY;
  for (let i = 0; i < scored.length; i++) {
    const { p, f, implied } = scored[i]!;
    let value = implied;
    if (value >= prev) value = Math.max(1, prev - 1);
    prev = value;
    rows.push({
      slug: p.slug,
      name: p.name,
      rank: i + 1,
      category: p.category,
      chains: [...p.chains],
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      implied_value_usd: value,
      multiple: f.multiple,
      multiple_source: f.multiple_source,
      momentum: f.momentum,
      maturity: f.maturity,
      breadth: f.breadth,
      peers: f.peers,
      signal: signalOf(value, maxImplied, f),
      watchlist: watchlist.has(p.slug),
      farm_steps: farmSteps(p),
    });
  }

  const categories: CategoryMultiple[] = [...multiples.byCategory.values()].sort((a, b) =>
    a.category < b.category ? -1 : a.category > b.category ? 1 : 0,
  );
  const tokenized = snapshot.protocols.filter((p) => !isPreToken(p));
  const examples = tokenized
    .filter((p) => p.mcap_usd !== null)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .slice(0, 8)
    .map((p) => ({ name: p.name, symbol: p.symbol, mcap_usd: p.mcap_usd }));

  return {
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      protocols_total: snapshot.protocols.length,
      pre_token_count: pre.length,
      watchlist_count: snapshot.watchlist.length,
      tokenized_count: tokenized.length,
    },
    model: {
      constants: MODEL,
      global_multiple: multiples.global.multiple,
      global_peers: multiples.global.peers,
      categories,
    },
    rows,
    live: { count: tokenized.length, examples },
  };
}
