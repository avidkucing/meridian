import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { confirmIndicatorPreset, checkDipFromHigh, checkLastCandleMomentum } from "./chart-indicators.js";
import { discoverGmgnPools, fetchGmgnTokenFeeSol } from "./gmgn.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
// Degen Score normalizes window-dependent inputs (volume/fee/LP) to this reference
// window, so its targets stay valid regardless of the configured screening timeframe.
const DEGEN_REFERENCE_MINUTES = 30;
const PVP_SHORTLIST_LIMIT = 2;
const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

export function scoreCandidate(pool) {
  if (Number.isFinite(Number(pool.gmgn_score))) {
    return Number(pool.gmgn_score) + Number(pool.fee_active_tvl_ratio || 0) * 500;
  }
  const feeTvl = Number(pool.fee_active_tvl_ratio || 0);
  const organic = Number(pool.organic_score || 0);
  const volume = Number(pool.volume_window || 0);
  const holders = Number(pool.holders || 0);
  return feeTvl * 1000 + organic * 10 + volume / 100 + holders / 100;
}

/**
 * Degen Score — a pool's efficiency relative to its liquidity, on a 0..100 scale.
 * Geometric mean of four liquidity-relative sub-scores so a HIGH score requires balance
 * across all four (a pool spiking one metric can't dominate):
 *   1. Recent trading activity   → volume / active_tvl   (volume_active_tvl_ratio)
 *   2. Recent LP activity        → unique_lps + positions_created
 *   3. Fees paid to LPs          → fee / active_tvl       (fee_active_tvl_ratio)
 *   4. Liquidity                 → active_tvl (log floor — dust pools can't win on ratios)
 * Efficiency only (no momentum/change_pct), per design. Targets are configurable so the
 * score can be calibrated; each sub-score saturates at its target.
 *
 * The volume/fee/LP inputs are measured over `config.screening.timeframe`, so they are
 * normalized to a fixed 30m reference window before scoring — the targets are expressed
 * in 30m terms and stay valid even if the timeframe changes (5m, 1h, 24h, …). Liquidity
 * is a level, not a rate, so it is not scaled.
 */
export function degenScore(pool, targets = {}) {
  const {
    targetVolRatio = 20,    // (30m) volume/active_tvl that earns a full trading sub-score
    targetLpCount = 40,     // (30m) unique_lps + positions_created for a full LP sub-score
    targetFeeRatio = 0.20,  // (30m) fee/active_tvl for a full fee sub-score
    targetLiquidity = 20000, // active_tvl ($) floor for full liquidity sub-score (not timeframe-scaled)
  } = targets;

  const La = Number(pool.active_tvl ?? pool.tvl ?? 0);
  if (!Number.isFinite(La) || La <= 0) return 0;

  const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

  // Normalize window-dependent inputs to the 30m reference (rate × scale).
  const tfMinutes = TIMEFRAME_MINUTES[config.screening.timeframe] || DEGEN_REFERENCE_MINUTES;
  const tfScale = DEGEN_REFERENCE_MINUTES / tfMinutes;

  const volRatio = Number(pool.volume_active_tvl_ratio);
  const tradingRatio = (Number.isFinite(volRatio) ? volRatio : Number(pool.volume_window || 0) / La) * tfScale;
  const feeRatio = (Number.isFinite(Number(pool.fee_active_tvl_ratio))
    ? Number(pool.fee_active_tvl_ratio)
    : Number(pool.fee_window || 0) / La) * tfScale;
  const lpActivity = (Number(pool.unique_lps || 0) + Number(pool.positions_created || 0)) * tfScale;

  const sTrading = clamp01(tradingRatio / targetVolRatio);
  const sLp      = clamp01(lpActivity / targetLpCount);
  const sFees    = clamp01(feeRatio / targetFeeRatio);
  const sLiq     = clamp01(Math.log10(La) / Math.log10(targetLiquidity));

  // Geometric mean (×100). Any zero sub-score → 0, enforcing balance across all four.
  return (sTrading * sLp * sFees * sLiq) ** 0.25 * 100;
}

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isUsableVolatility(value) {
  const n = numeric(value);
  return n != null && n > 0;
}

function includesCaseInsensitive(values, value) {
  if (!Array.isArray(values) || values.length === 0 || !value) return false;
  const needle = String(value).toLowerCase();
  return values.some((entry) => String(entry).toLowerCase() === needle);
}

function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null;
}

function getPoolBaseMint(pool) {
  return pool?.token_x?.address ||
    pool?.base_token_address ||
    pool?.base_mint ||
    pool?.base?.mint ||
    null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function getRawPoolScreeningRejectReason(pool, s) {
  const base = pool?.token_x || {};
  const quote = pool?.token_y || {};
  const binStep = numeric(pool?.dlmm_params?.bin_step);
  const tvl = numeric(pool?.tvl ?? pool?.active_tvl);
  const feeActiveTvlRatio = numeric(pool?.fee_active_tvl_ratio);
  const volatility = numeric(pool?.volatility);
  const volume = numeric(pool?.volume);
  const holders = numeric(pool?.base_token_holders);
  const mcap = numeric(base?.market_cap);
  const baseOrganic = numeric(base?.organic_score);
  const quoteOrganic = numeric(quote?.organic_score);
  const launchpad = getPoolLaunchpad(pool);
  const createdAt = numeric(base?.created_at);

  if (s.excludeHighSupplyConcentration && pool?.base_token_has_high_supply_concentration === true) {
    return "base token has high supply concentration";
  }
  if (pool?.base_token_has_critical_warnings === true) return "base token has critical warnings";
  if (pool?.quote_token_has_critical_warnings === true) return "quote token has critical warnings";
  if (quote?.address !== config.tokens.SOL && quote?.symbol !== "SOL" && quote?.symbol !== "WSOL") {
    return `quote token is ${quote?.symbol || quote?.address || "unknown"} — only SOL pairs supported`;
  }
  if (pool?.base_token_has_high_single_ownership === true) return "base token has high single ownership";
  if (pool?.pool_type && pool.pool_type !== "dlmm") return `pool_type ${pool.pool_type} is not dlmm`;

  if (mcap == null || mcap < s.minMcap) return `mcap ${mcap ?? "unknown"} below minMcap ${s.minMcap}`;
  if (mcap > s.maxMcap) return `mcap ${mcap} above maxMcap ${s.maxMcap}`;
  if (holders == null || holders < s.minHolders) return `holders ${holders ?? "unknown"} below minHolders ${s.minHolders}`;
  if (volume == null || volume < s.minVolume) return `volume ${volume ?? "unknown"} below minVolume ${s.minVolume}`;
  if (tvl == null || tvl < s.minTvl) return `TVL ${tvl ?? "unknown"} below minTvl ${s.minTvl}`;
  if (s.maxTvl != null && tvl > s.maxTvl) return `TVL ${tvl} above maxTvl ${s.maxTvl}`;
  if (binStep == null || binStep < s.minBinStep) return `bin_step ${binStep ?? "unknown"} below minBinStep ${s.minBinStep}`;
  if (binStep > s.maxBinStep) return `bin_step ${binStep} above maxBinStep ${s.maxBinStep}`;
  // if (!isUsableVolatility(volatility)) return `volatility ${volatility ?? "unknown"} unusable`;
  if (feeActiveTvlRatio == null || feeActiveTvlRatio < s.minFeeActiveTvlRatio) {
    return `fee/active-TVL ${feeActiveTvlRatio ?? "unknown"} below minFeeActiveTvlRatio ${s.minFeeActiveTvlRatio}`;
  }
  if (baseOrganic == null || baseOrganic < s.minOrganic) {
    return `base organic ${baseOrganic ?? "unknown"} below minOrganic ${s.minOrganic}`;
  }
  if (quoteOrganic == null || quoteOrganic < s.minQuoteOrganic) {
    return `quote organic ${quoteOrganic ?? "unknown"} below minQuoteOrganic ${s.minQuoteOrganic}`;
  }
  if (
    pool?.discord_signal &&
    Array.isArray(s.allowedLaunchpads) &&
    s.allowedLaunchpads.length > 0 &&
    launchpad &&
    !includesCaseInsensitive(s.allowedLaunchpads, launchpad)
  ) {
    return `launchpad ${launchpad} not in allow-list`;
  }
  if (includesCaseInsensitive(s.blockedLaunchpads, launchpad)) {
    return `blocked launchpad (${launchpad})`;
  }
  if (s.minTokenAgeHours != null) {
    const maxCreatedAt = Date.now() - s.minTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt > maxCreatedAt) return `token age below minTokenAgeHours ${s.minTokenAgeHours}`;
  }
  if (s.maxTokenAgeHours != null) {
    const minCreatedAt = Date.now() - s.maxTokenAgeHours * 3_600_000;
    if (createdAt == null || createdAt < minCreatedAt) return `token age above maxTokenAgeHours ${s.maxTokenAgeHours}`;
  }
  return null;
}

async function fetchDiscordSignalCandidates() {
  const res = await fetch(`${config.api.url}/signals/discord/candidates`, {
    headers: config.api.publicApiKey ? { "x-api-key": config.api.publicApiKey } : {},
  });
  if (!res.ok) throw new Error(`discord signal candidates ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.candidates) ? data.candidates : [];
}

async function fetchPoolDiscoveryPage({ page_size, filters, timeframe, category, pages = 2 }) {
  const categories = ["new", "top", "trending"];
  const pageResults = [];

  for (const c of categories) {
    let afterKey = null;
    for (let p = 0; p < pages; p++) {
      const url = `${POOL_DISCOVERY_BASE}/pools?` +
        `page_size=${page_size}` +
        `&filter_by=${encodeURIComponent(filters)}` +
        `&timeframe=${timeframe}` +
        `&category=${c}` +
        (afterKey ? `&after_key=${encodeURIComponent(afterKey)}` : "");

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      if (Array.isArray(data.data)) {
        pageResults.push(...data.data);
      }
      if (!data.has_more || !data.after_key) break;
      afterKey = data.after_key;
    }
  }
  return pageResults;
}

async function fetchPoolDiscoveryDetail({ poolAddress, timeframe }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  return (data.data || [])[0] ?? null;
}

async function applyVolatilityTimeframe(rawPools, sourceTimeframe) {
  if (!Array.isArray(rawPools) || rawPools.length === 0) return rawPools;
  const volatilityTimeframe = getVolatilityTimeframe(sourceTimeframe);

  // Tag primary-timeframe values on every pool before any overwrite
  for (const pool of rawPools) {
    if (!pool) continue;
    pool[`volume_${sourceTimeframe}`] = pool.volume ?? null;
    pool[`volatility_${sourceTimeframe}`] = pool.volatility ?? null;
    pool.volatility_timeframe = volatilityTimeframe;
  }

  if (sourceTimeframe === volatilityTimeframe) return rawPools;

  const uniquePoolAddresses = [...new Set(rawPools.map((pool) => pool?.pool_address).filter(Boolean))];
  const longResults = await Promise.allSettled(
    uniquePoolAddresses.map((poolAddress) =>
      fetchPoolDiscoveryDetail({ poolAddress, timeframe: volatilityTimeframe })
        .then((pool) => ({
          poolAddress,
          volatility: numeric(pool?.volatility),
          volume: numeric(pool?.volume),
        }))
    )
  );

  const metricsByPool = new Map();
  for (const result of longResults) {
    if (result.status !== "fulfilled") continue;
    metricsByPool.set(result.value.poolAddress, result.value);
  }

  for (const pool of rawPools) {
    if (!pool?.pool_address) continue;
    const metrics = metricsByPool.get(pool.pool_address);
    if (!metrics) continue;

    pool[`volume_${volatilityTimeframe}`] = metrics.volume;
    pool[`volatility_${volatilityTimeframe}`] = metrics.volatility;

    // Use longer-timeframe values as the canonical ones for filtering
    if (metrics.volatility != null) pool.volatility = metrics.volatility;
    if (metrics.volume != null) pool.volume = metrics.volume;
  }

  return rawPools;
}

async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

async function enrichDiscordSignalLaunchpads(rawPools) {
  const missing = rawPools.filter((pool) =>
    pool?.discord_signal &&
    !getPoolLaunchpad(pool) &&
    getPoolBaseMint(pool)
  );
  if (missing.length === 0) return;

  const uniqueMints = [...new Set(missing.map(getPoolBaseMint).filter(Boolean))];
  const results = await Promise.allSettled(
    uniqueMints.map(async (mint) => {
      const assets = await searchAssetsBySymbol(mint);
      const asset = assets.find((item) => item?.id === mint) || assets[0] || null;
      return { mint, asset };
    })
  );

  const byMint = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const launchpad = result.value.asset?.launchpad || result.value.asset?.launchpadPlatform || null;
    if (!launchpad) continue;
    byMint.set(result.value.mint, {
      launchpad,
      dev: result.value.asset?.dev || null,
      holderCount: numeric(result.value.asset?.holderCount),
      organicScore: numeric(result.value.asset?.organicScore),
      marketCap: numeric(result.value.asset?.mcap ?? result.value.asset?.fdv),
      createdAt: result.value.asset?.createdAt ? Date.parse(result.value.asset.createdAt) : null,
    });
  }

  for (const pool of missing) {
    const mint = getPoolBaseMint(pool);
    const asset = byMint.get(mint);
    if (!asset) continue;
    pool.token_x ||= {};
    pool.token_x.launchpad = asset.launchpad;
    pool.base_token_launchpad = asset.launchpad;
    if (asset.dev && !pool.token_x.dev) pool.token_x.dev = asset.dev;
    if (asset.holderCount != null && pool.base_token_holders == null) pool.base_token_holders = asset.holderCount;
    if (asset.organicScore != null && pool.token_x.organic_score == null) pool.token_x.organic_score = asset.organicScore;
    if (asset.marketCap != null && pool.token_x.market_cap == null) pool.token_x.market_cap = asset.marketCap;
    if (asset.createdAt != null && pool.token_x.created_at == null) pool.token_x.created_at = asset.createdAt;
    log("screening", `Discord signal launchpad enriched from Jupiter: ${pool.name || mint} — ${asset.launchpad}`);
  }
}

async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rival pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

async function enrichPvpRisk(pools) {
  const shortlist = [...pools]
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, PVP_SHORTLIST_LIMIT);

  if (shortlist.length === 0) return;

  const symbolCache = new Map();

  await Promise.all(shortlist.map(async (pool) => {
    const symbol = normalizeSymbol(pool.base?.symbol);
    const ownMint = pool.base?.mint;
    if (!symbol || !ownMint) return;

    let assets = symbolCache.get(symbol);
    if (!assets) {
      assets = await searchAssetsBySymbol(symbol).catch(() => []);
      symbolCache.set(symbol, assets);
    }

    const rivalAssets = assets
      .filter((asset) => normalizeSymbol(asset?.symbol) === symbol && asset?.id && asset.id !== ownMint)
      .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
      .slice(0, PVP_RIVAL_LIMIT);

    for (const rival of rivalAssets) {
      const rivalHolders = Number(rival?.holderCount || 0);
      const rivalFees = Number(rival?.fees || 0);
      if (rivalHolders < PVP_MIN_HOLDERS || rivalFees < PVP_MIN_GLOBAL_FEES_SOL) continue;

      const rivalPool = await findRivalPool(rival.id).catch(() => null);
      if (!rivalPool) continue;

      pool.is_pvp = true;
      pool.pvp_risk = "high";
      pool.pvp_symbol = pool.base?.symbol || symbol;
      pool.pvp_rival_name = rival?.name || pool.pvp_symbol;
      pool.pvp_rival_mint = rival.id;
      pool.pvp_rival_pool = rivalPool.address;
      pool.pvp_rival_tvl = round(Number(rivalPool.tvl || 0));
      pool.pvp_rival_holders = rivalHolders;
      pool.pvp_rival_fees = Number(rivalFees.toFixed(2));
      log("screening", `PVP guard: ${pool.name} has active rival ${pool.pvp_rival_name} (${rival.id.slice(0, 8)})`);
      break;
    }
  }));
}



/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 */

/**
 * Refresh live metrics for discord-only signal pools.
 * Their discovery_pool is a snapshot from when the signal was captured — volume/volatility/fee
 * can be 0 even if the pool is active right now. We overwrite with fresh data from the
 * pool discovery API so filtering uses current numbers, not stale ones.
 */
async function refreshDiscordOnlyPools(pools, timeframe) {
  if (!pools.length) return;
  const FIELDS = ["volume", "fee", "active_tvl", "tvl", "volatility", "fee_active_tvl_ratio"];
  const results = await Promise.allSettled(
    pools.map((pool) =>
      fetchPoolDiscoveryDetail({ poolAddress: pool.pool_address, timeframe })
        .then((fresh) => ({ pool, fresh }))
    )
  );
  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value.fresh) continue;
    const { pool, fresh } = result.value;
    for (const field of FIELDS) {
      const val = numeric(fresh[field]);
      if (val != null) pool[field] = val;
    }
    log("screening", `Discord signal refreshed live data: ${pool.name || pool.pool_address} — vol=${pool.volume?.toFixed(0)} fee=${pool.fee?.toFixed(2)}`);
  }
}

export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    s.excludeHighSupplyConcentration ? "base_token_has_high_supply_concentration=false" : null,
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    s.maxTvl != null ? `tvl<=${s.maxTvl}` : null,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    `base_token_organic_score>=${s.minOrganic}`,
    `quote_token_organic_score>=${s.minQuoteOrganic}`,
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
    Array.isArray(s.allowedLaunchpads) && s.allowedLaunchpads.length > 0
      ? `base_token_launchpad=[${s.allowedLaunchpads.join(",")}]`
      : null,
  ].filter(Boolean).join("&&");

  const data = await fetchPoolDiscoveryPage({
    page_size,
    filters,
    timeframe: s.timeframe,
    category: s.category,
  });

  let rawPools = data;
  log("screening", `Fetched ${rawPools.length} pools from discovery with filters: ${filters}`);

  if (config.screening.useDiscordSignals) {
    const signalCandidates = await fetchDiscordSignalCandidates().catch((error) => {
      log("screening", `Discord signal fetch failed: ${error.message}`);
      return [];
    });
    const signalPools = signalCandidates
      .map((candidate) => {
        const discoveryPool = candidate.discovery_pool;
        if (!discoveryPool?.pool_address) return null;
        return {
          ...discoveryPool,
          discord_signal: true,
          discord_signal_count: candidate.source_count || 1,
          discord_signal_seen_count: candidate.seen_count || 1,
          discord_signal_first_seen_at: candidate.first_seen_at || null,
          discord_signal_last_seen_at: candidate.last_seen_at || null,
        };
      })
      .filter(Boolean);

    if (config.screening.discordSignalMode === "only") {
      rawPools = signalPools;
      // Refresh all signal pools with live data since discovery_pool is a stale snapshot
      await refreshDiscordOnlyPools(rawPools, s.timeframe);
    } else if (signalPools.length > 0) {
      const byPool = new Map(rawPools.map((pool) => [pool.pool_address, pool]));
      const discordOnlyPools = [];
      for (const signalPool of signalPools) {
        if (byPool.has(signalPool.pool_address)) {
          byPool.set(signalPool.pool_address, {
            ...byPool.get(signalPool.pool_address),
            discord_signal: true,
            discord_signal_count: signalPool.discord_signal_count,
            discord_signal_seen_count: signalPool.discord_signal_seen_count,
            discord_signal_first_seen_at: signalPool.discord_signal_first_seen_at,
            discord_signal_last_seen_at: signalPool.discord_signal_last_seen_at,
          });
        } else {
          byPool.set(signalPool.pool_address, signalPool);
          discordOnlyPools.push(signalPool);
        }
      }
      rawPools = Array.from(byPool.values());
      // Refresh discord-only pools with live data — their discovery_pool is a stale snapshot
      // so volume/volatility/fee may be 0 even when the pool is active right now
      if (discordOnlyPools.length > 0) {
        await refreshDiscordOnlyPools(discordOnlyPools, s.timeframe);
      }
    }
  }

  rawPools = await applyVolatilityTimeframe(rawPools, s.timeframe);
  await enrichDiscordSignalLaunchpads(rawPools);

  const filteredExamples = [];
  const thresholdedRawPools = rawPools.filter((pool) => {
    const reason = getRawPoolScreeningRejectReason(pool, s);
    if (!reason) return true;
    // filteredExamples.push({ name: pool.name || pool.pool_address || "unknown pool", reason });
    // if (pool.discord_signal) log("screening", `Discord signal filtered: ${pool.name || pool.pool_address} — ${reason}`);
    return false;
  });

  const condensed = thresholdedRawPools.map(condensePool);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = condensed.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: data.total,
    pools,
    filtered_examples: filteredExamples,
  };
}

async function fetchFreshPoolDetail(poolAddress) {
  const tf = config.screening.timeframe || "5m";
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(poolAddress)}&sort_by=tvl:desc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DLMM API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = data?.data || [];
  const pool = pools.find(p => p.address === poolAddress) || pools[0];
  if (!pool) return null;
  const fees = pool.fees || {};
  const volumes = pool.volume || {};
  const feeTvlRatios = pool.fee_tvl_ratio || {};
  const WINDOW_MAP = {
    "5m": ["30m", "1h"], "15m": ["30m", "1h"], "30m": ["30m", "1h"],
    "1h": ["1h", "2h"], "2h": ["2h", "4h"], "4h": ["4h", "12h"],
    "12h": ["12h", "24h"], "24h": ["24h", "24h"],
  };
  const [curKey, prevKey] = WINDOW_MAP[tf] ?? ["30m", "1h"];
  const feeWindow = fees[curKey] ?? fees["30m"] ?? 0;
  const volumeWindow = volumes[curKey] ?? volumes["30m"] ?? 0;
  const feeTvlRatio = feeTvlRatios[curKey] ?? feeTvlRatios["30m"] ?? 0;
  function pctChange(current, previous) {
    if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return 0;
    return ((current - previous) / previous) * 100;
  }
  return {
    pool_address: pool.address,
    tvl: pool.tvl,
    active_tvl: pool.tvl,
    fee: feeWindow,
    volume: volumeWindow,
    fee_active_tvl_ratio: feeTvlRatio,
    fee_change_pct: pctChange(fees[curKey], fees[prevKey]),
    volume_change_pct: pctChange(volumes[curKey], volumes[prevKey]),
    bin_step: pool.pool_config?.bin_step,
    pool_config: pool.pool_config,
  };
}

export async function getTopCanditatesWithAllSources({ limit = 10, positions = [] } = {}) {
  const sources = ["meteora", "gmgn"];
  const results = {
    candidates: [],
    total_eligible: 0,
    total_screened: 0,
    source: 'all',
    filtered_examples: [],
    stage_counts: null,
    all_filtered: [],
  };
  for (const source of sources) {
    try {
      const res = await getTopCandidates({ limit, source });
      results.candidates.push(...res.candidates);
      results.total_eligible += res.total_eligible;
      results.total_screened += res.total_screened;
      results.filtered_examples.push(...res.filtered_examples);
      if (res.stage_counts) {
        results.stage_counts = results.stage_counts || {};
        for (const [stage, count] of Object.entries(res.stage_counts)) {
          results.stage_counts[stage] = (results.stage_counts[stage] || 0) + count;
        }
      }
      if (Array.isArray(res.all_filtered)) {
        results.all_filtered.push(...res.all_filtered);
      }
    } catch (error) {
      log("screening", `Error fetching candidates from source ${source}: ${error.message}`);
    }
  }
  // Deduplicate by pool address across all sources.
  const seenPools = new Set();
  results.candidates = results.candidates.filter((c) => {
    if (seenPools.has(c.pool)) return false;
    seenPools.add(c.pool);
    return true;
  });
  results.all_filtered = results.all_filtered.filter((f) => {
    if (!f.pool) return true;
    if (seenPools.has(f.pool)) return false;
    seenPools.add(f.pool);
    return true;
  });

  // Sort before enrichment so we enrich highest-scored candidates first
  results.candidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  results.candidates = results.candidates.slice(0, limit);

  // Build mint → cached GMGN data so Meteora candidates for the same token reuse
  // already-fetched data instead of calling fetchGmgnTokenFeeSol again.
  const gmgnFeeByMint  = new Map(); // mint → total_fee_sol
  const gmgnAthByMint  = new Map(); // mint → price_vs_ath_pct
  for (const pool of results.candidates) {
    const mint = pool.base?.mint;
    if (pool.gmgn && mint) {
      if (pool.gmgn_total_fee_sol != null) gmgnFeeByMint.set(mint, pool.gmgn_total_fee_sol);
      if (pool.price_vs_ath_pct    != null) gmgnAthByMint.set(mint, pool.price_vs_ath_pct);
    }
  }

  // Per-candidate enrichment: fresh pool metrics + token info + narrative (for halal filter)
  const { getTokenInfo, getTokenNarrative } = await import("./token.js");
  const { checkHalal } = await import("./halal-filter.js");
  for (const pool of results.candidates) {
    const mint = pool.base?.mint;
    // Reuse GMGN fee from the batch if available; only call out for mints not seen in GMGN discovery
    const needsGmgnFetch = !pool.gmgn && mint && !gmgnFeeByMint.has(mint);
    const [freshDetail, gmgnFee, tokenInfo, narrativeResult] = await Promise.allSettled([
      fetchFreshPoolDetail(pool.pool),
      needsGmgnFetch ? fetchGmgnTokenFeeSol(mint) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
    ]);
    // Attach token info for the filter below and for index.js to reuse without re-fetching
    pool._ti = tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null;
    pool._narrative = narrativeResult.status === "fulfilled" ? narrativeResult.value?.narrative ?? null : null;

    const fd = freshDetail.status === "fulfilled" ? freshDetail.value : null;
    if (fd) {
      // Only update fee_active_tvl_ratio when fresh TVL is substantial enough to be reliable.
      // The DLMM API computes fee_tvl_ratio as fee/tvl*100 at query time, so for new/
      // bootstrapping pools with tiny in-range TVL the ratio explodes (e.g. 47% instead of 0.7%).
      // Below minTvl, keep the Discovery API's pre-filtered value which uses a more stable window.
      const freshTvl = fd.tvl ?? 0;
      if (freshTvl >= (config.screening.minTvl ?? 0)) {
        pool.fee_active_tvl_ratio = fd.fee_active_tvl_ratio ?? pool.fee_active_tvl_ratio;
      }
      pool.tvl                  = fd.tvl                  ?? pool.tvl;
      pool.fee_change_pct       = fd.fee_change_pct       ?? pool.fee_change_pct;
      pool.volume_change_pct    = fd.volume_change_pct    ?? pool.volume_change_pct;
      pool.bin_step             = fd.bin_step             ?? pool.bin_step;
      pool.fee_window           = fd.fee                  ?? pool.fee_window;
      pool.volume_window        = fd.volume               ?? pool.volume_window;
    }
    if (!pool.gmgn) {
      const gmgnData = gmgnFee.status === "fulfilled" ? gmgnFee.value : null;
      const feeSol = gmgnFeeByMint.get(mint) ?? gmgnData?.total_fee ?? null;
      if (feeSol != null) pool.gmgn_total_fee_sol = feeSol;
      if (pool.price_vs_ath_pct == null) {
        const ath = gmgnAthByMint.get(mint) ?? gmgnData?.price_vs_ath_pct ?? null;
        if (ath != null) pool.price_vs_ath_pct = ath;
      }
    }
    await new Promise(r => setTimeout(r, 150)); // avoid 429s
  }

  // Unified filter — runs once for all sources on fresh enriched data
  const occupiedPools = new Set(positions.map(p => p.pool));
  const occupiedMints = new Set(positions.map(p => p.base_mint).filter(Boolean));
  const filteredOut = [];

  const minFeeChangePct     = config.screening.minFeeChangePct != null ? Number(config.screening.minFeeChangePct) : null;
  const minVolumeChangePct  = config.screening.minVolumeChangePct != null ? Number(config.screening.minVolumeChangePct) : null;
  const maxPriceChange1hPct = config.screening.maxPriceChange1hPct != null ? Number(config.screening.maxPriceChange1hPct) : null;
  const maxVolatility       = config.screening.maxVolatilityToDeploy != null ? Number(config.screening.maxVolatilityToDeploy) : null;
  const maxTop10Pct         = config.screening.maxTop10Pct != null ? Number(config.screening.maxTop10Pct) : null;
  const maxBotHoldersPct    = config.screening.maxBotHoldersPct != null ? Number(config.screening.maxBotHoldersPct) : null;
  const athFilter = config.screening.athFilterPct;
  const minFeesSol = config.screening.minTokenFeesSol;
  const minTvl = Number(config.screening.minTvl ?? 0);
  const maxTvl = config.screening.maxTvl == null ? null : Number(config.screening.maxTvl);

  results.candidates = results.candidates.filter((pool) => {
    const mint = pool.base?.mint || pool.base_mint || null;

    if (occupiedPools.has(pool.pool)) {
      log("screening", `Skipping ${pool.name} — already have an open position in this pool`);
      filteredOut.push({ name: pool.name, reason: "already have an open position in this pool" });
      return false;
    }
    if (!config.risk.allowMultiplePositionsPerToken && mint && occupiedMints.has(mint)) {
      log("screening", `Skipping ${pool.name} — already holding this base token in another pool`);
      filteredOut.push({ name: pool.name, reason: "already holding this base token in another pool" });
      return false;
    }

    // Launchpad allow/block — GMGN pools have no launchpad field so this stays source-gated
    if (!pool.gmgn) {
      const launchpad = pool.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
    }

    if (pool.dev && isDevBlocked(pool.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${pool.dev.slice(0, 8)} token ${pool.base?.symbol}`);
      filteredOut.push({ name: pool.name, reason: "blocked deployer" });
      return false;
    }

    // ATH distance
    if (athFilter != null && pool.price_vs_ath_pct != null) {
      const threshold = 100 + athFilter;
      if (pool.price_vs_ath_pct > threshold) {
        log("screening", `ATH filter: dropped ${pool.name} — ${pool.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
        filteredOut.push({ name: pool.name, reason: `${pool.price_vs_ath_pct}% of ATH > ${threshold}% limit` });
        return false;
      }
    }

    const tvl = pool.tvl;
    if (tvl == null) {
      log("screening", `TVL filter: dropped ${pool.name} — unable to fetch fresh TVL`);
      filteredOut.push({ name: pool.name, reason: "unable to fetch fresh TVL" });
      return false;
    }
    if (minTvl > 0 && tvl < minTvl) {
      log("screening", `TVL filter: dropped ${pool.name} — fresh TVL $${tvl} < $${minTvl}`);
      filteredOut.push({ name: pool.name, reason: `fresh TVL $${tvl} < $${minTvl}` });
      return false;
    }
    if (maxTvl != null && tvl > maxTvl) {
      log("screening", `TVL filter: dropped ${pool.name} — fresh TVL $${tvl} > $${maxTvl}`);
      filteredOut.push({ name: pool.name, reason: `fresh TVL $${tvl} > $${maxTvl}` });
      return false;
    }

    if (minFeesSol != null && minFeesSol > 0) {
      const feesSol = Number(pool.gmgn_total_fee_sol ?? pool._ti?.global_fees_sol);
      if (Number.isFinite(feesSol) && feesSol < minFeesSol) {
        log("screening", `Token fee filter: dropped ${pool.name} — ${feesSol.toFixed(2)} SOL < ${minFeesSol} SOL`);
        filteredOut.push({ name: pool.name, reason: `token fees ${feesSol.toFixed(2)} SOL < ${minFeesSol} SOL` });
        return false;
      }
    }

    // Bot holders — _ti is fetched for all pools; remove source gate
    const botPct = pool._ti?.audit?.bot_holders_pct;
    if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
      log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
      filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
      return false;
    }

    // Top-10 holder concentration — _ti available for all pools
    const _top10Raw = pool._ti?.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct;
    const top10Pct = _top10Raw != null ? parseFloat(_top10Raw) : null;
    if (maxTop10Pct != null && top10Pct != null && top10Pct > maxTop10Pct) {
      log("screening", `Top10 filter: dropped ${pool.name} — top10 ${top10Pct.toFixed(1)}% > ${maxTop10Pct}%`);
      filteredOut.push({ name: pool.name, reason: `top10 ${top10Pct.toFixed(1)}% > ${maxTop10Pct}%` });
      return false;
    }

    // Volatility ceiling — applies to all pools
    if (maxVolatility != null && pool.volatility != null && pool.volatility > maxVolatility) {
      log("screening", `Volatility filter: dropped ${pool.name} — volatility ${pool.volatility} > ${maxVolatility}`);
      filteredOut.push({ name: pool.name, reason: `volatility ${pool.volatility} > maxVolatilityToDeploy ${maxVolatility}` });
      return false;
    }

    const feeActiveTvlRatio = pool.fee_active_tvl_ratio;
    if (feeActiveTvlRatio != null && feeActiveTvlRatio < config.screening.minFeeActiveTvlRatio) {
      log("screening", `Fee/TVL filter: ${pool.name} — fee/tvl ${feeActiveTvlRatio}% < ${config.screening.minFeeActiveTvlRatio}%`);
      filteredOut.push({ name: pool.name, reason: `fee/tvl ${feeActiveTvlRatio}% < ${config.screening.minFeeActiveTvlRatio}%` });
      return false;
    }

    // Fee change — fail-closed: if configured and data unavailable after enrichment, block the pool
    if (minFeeChangePct != null) {
      if (pool.fee_change_pct == null) {
        log("screening", `Fee change filter: dropped ${pool.name} — fee_change_pct unavailable (fail-closed)`);
        filteredOut.push({ name: pool.name, reason: "fee_change_pct unavailable (fail-closed)" });
        return false;
      }
      if (pool.fee_change_pct < minFeeChangePct) {
        log("screening", `Fee change filter: dropped ${pool.name} — fee_change_pct ${pool.fee_change_pct}% < ${minFeeChangePct}%`);
        filteredOut.push({ name: pool.name, reason: `fee_change_pct ${pool.fee_change_pct}% < ${minFeeChangePct}%` });
        return false;
      }
    }
    // Volume change — same fail-closed approach
    if (minVolumeChangePct != null) {
      if (pool.volume_change_pct == null) {
        log("screening", `Volume change filter: dropped ${pool.name} — volume_change_pct unavailable (fail-closed)`);
        filteredOut.push({ name: pool.name, reason: "volume_change_pct unavailable (fail-closed)" });
        return false;
      }
      if (pool.volume_change_pct < minVolumeChangePct) {
        log("screening", `Volume change filter: dropped ${pool.name} — volume_change_pct ${pool.volume_change_pct}% < ${minVolumeChangePct}%`);
        filteredOut.push({ name: pool.name, reason: `volume_change_pct ${pool.volume_change_pct}% < ${minVolumeChangePct}%` });
        return false;
      }
    }

    const priceChange1h = pool.price_change_1h ?? null;
    if (maxPriceChange1hPct != null && priceChange1h != null && priceChange1h > maxPriceChange1hPct) {
      log("screening", `Pump filter: dropped ${pool.name} — price_change_1h ${priceChange1h}% > ${maxPriceChange1hPct}%`);
      filteredOut.push({ name: pool.name, reason: `price_change_1h ${priceChange1h}% > ${maxPriceChange1hPct}%` });
      return false;
    }

    if (config.screening.halalFilter) {
      const halal = checkHalal({
        narrative: pool._narrative,
        twitter: pool._ti?.twitter,
        website: pool._ti?.website,
      });
      if (halal.blocked) {
        log("screening", `Halal filter: dropped ${pool.name} — ${halal.category} (${halal.pattern})`);
        filteredOut.push({ name: pool.name, reason: `non-halal: ${halal.category}` });
        return false;
      }
    }

    return true;
  });

  if (filteredOut.length > 0) {
    results.all_filtered.push(...filteredOut);
    results.filtered_examples.push(...filteredOut.slice(0, 3));
  }

  // Bear-candle momentum filter — runs after enrichment so pool._ti?.stats_1h?.price_change is available
  if (config.indicators.bearCandleFilter && results.candidates.length > 0) {
    const maxBodyPct = config.indicators.bearCandleMaxBodyPct ?? 3;
    const p1hMin     = config.indicators.bearCandleP1hMin ?? 0;
    const p1hMax     = config.indicators.bearCandleP1hMax ?? 30;
    const momentumChecks = await Promise.all(
      results.candidates.map(async (pool) => {
        const p1h = parseFloat(pool._ti?.stats_1h?.price_change ?? 0);
        try {
          const check = await checkLastCandleMomentum(pool.pool, p1h, { maxBodyPct, p1hMin, p1hMax });
          return { pool: pool.pool, check };
        } catch (error) {
          return { pool: pool.pool, check: { confirmed: true, reason: `Momentum check unavailable: ${error.message}` } };
        }
      }),
    );
    const momentumByPool = new Map(momentumChecks.map((e) => [e.pool, e.check]));
    const before = results.candidates.length;
    const momentumOut = [];
    results.candidates = results.candidates.filter((pool) => {
      const check = momentumByPool.get(pool.pool);
      pool.momentum_check = check || null;
      if (!check || check.confirmed) return true;
      pushFilteredReason(momentumOut, pool, `momentum filter: ${check.reason}`);
      log("screening", `Momentum filter rejected ${pool.name || pool.pool.slice(0, 8)}: ${check.reason}`);
      return false;
    });
    if (momentumOut.length > 0) {
      results.all_filtered.push(...momentumOut);
      results.filtered_examples.push(...momentumOut.slice(0, 3));
    }
    if (results.candidates.length < before) {
      log("screening", `Momentum filter removed ${before - results.candidates.length} candidate(s) (bear candle <${maxBodyPct}% body + p1h ${p1hMin}–${p1hMax}%)`);
    }
  }

  return results;
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ 
  limit = 10, 
  source = String(config.screening.source || "meteora").toLowerCase(),
} = {}) {
  const { config } = await import("../config.js");
  if (!["meteora", "gmgn"].includes(source)) {
    throw new Error(`Invalid screeningSource: ${config.screening.source}. Use meteora or gmgn.`);
  }
  const discovery = source === "gmgn"
    ? await discoverGmgnPools({ limit: Math.max(limit, config.gmgn.enrichLimit || 20) })
    : await discoverPools({ page_size: 50 });
  let { pools } = discovery;
  const filteredOut = Array.isArray(discovery.filtered_examples) ? [...discovery.filtered_examples] : [];

  // Token blacklist + dev blocklist (Meteora path runs these inside discoverPools; GMGN path does not)
  if (source === "gmgn") {
    const before = pools.length;
    pools = pools.filter((p) => {
      if (isBlacklisted(p.base?.mint)) {
        log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "blacklisted token");
        return false;
      }
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    if (pools.length < before) log("blacklist", `GMGN: filtered ${before - pools.length} blacklisted/blocked pool(s)`);
  }

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map(p => p.pool));
  const occupiedMints = new Set(positions.map(p => p.base_mint).filter(Boolean));
  const minTvl = source === "gmgn"
    ? Number(config.gmgn.minTvl ?? config.screening.minTvl ?? 0)
    : Number(config.screening.minTvl ?? 0);
  const maxTvl = config.screening.maxTvl == null ? null : Number(config.screening.maxTvl);
  const minFeeActiveTvlRatio = Number(config.screening.minFeeActiveTvlRatio ?? 0);
  const eligible = pools
    .filter((p) => {
      const tvl = Number(p.tvl ?? p.active_tvl ?? 0);
      if (Number.isFinite(minTvl) && minTvl > 0 && tvl < minTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} below minTvl $${minTvl}`);
        return false;
      }
      if (Number.isFinite(maxTvl) && maxTvl > 0 && tvl > maxTvl) {
        pushFilteredReason(filteredOut, p, `TVL $${tvl} above maxTvl $${maxTvl}`);
        return false;
      }
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (!config.risk.allowMultiplePositionsPerToken && occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      return true;
    })
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
    .slice(0, limit);

  if (config.screening.avoidPvpSymbols && eligible.length > 0) {
    await enrichPvpRisk(eligible);
    if (config.screening.blockPvpSymbols) {
      const before = eligible.length;
      const pvpRemoved = eligible.filter((p) => p.is_pvp);
      pvpRemoved.forEach((p) => pushFilteredReason(filteredOut, p, "PVP hard filter"));
      eligible.splice(0, eligible.length, ...eligible.filter((p) => !p.is_pvp));
      if (eligible.length < before) {
        log("screening", `PVP hard filter removed ${before - eligible.length} pool(s)`);
      }
    }
  }

  if (config.indicators.enabled && eligible.length > 0) {
    const confirmations = await Promise.all(
      eligible.map(async (pool) => {
        try {
          const confirmation = await confirmIndicatorPreset({
            mint: pool.base?.mint,
            side: "entry",
          });
          return { pool: pool.pool, confirmation };
        } catch (error) {
          return {
            pool: pool.pool,
            confirmation: {
              enabled: true,
              confirmed: true,
              skipped: true,
              reason: `Indicator confirmation unavailable: ${error.message}`,
              intervals: [],
            },
          };
        }
      }),
    );
    const confirmationByPool = new Map(confirmations.map((entry) => [entry.pool, entry.confirmation]));
    const before = eligible.length;
    const confirmedEligible = eligible.filter((pool) => {
      const confirmation = confirmationByPool.get(pool.pool);
      pool.indicator_confirmation = confirmation || null;
      if (!confirmation || confirmation.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `indicator reject: ${confirmation.reason}`);
      log("screening", `Indicator rejected ${pool.name} (${pool.pool.slice(0, 8)}): ${confirmation.reason}`);
      return false;
    });
    eligible.splice(0, eligible.length, ...confirmedEligible);
    if (eligible.length < before) {
      log("screening", `Indicator confirmation removed ${before - eligible.length} candidate(s)`);
    }
  }

  // Dip-from-high filter — only pass pools where price has pulled back ≥ minDipPct%
  // from the 20-candle high. Runs regardless of config.indicators.enabled.
  const minDipPct = config.indicators.minDipPct ?? 0;
  if (minDipPct > 0 && eligible.length > 0) {
    const dipLookback = config.indicators.dipLookbackCandles ?? 20;
    const dipChecks = await Promise.all(
      eligible.map(async (pool) => {
        try {
          const check = await checkDipFromHigh(pool.pool, {
            minDipPct,
            dipLookbackCandles: dipLookback,
          });
          return { pool: pool.pool, check };
        } catch (error) {
          // Non-blocking: if OHLCV is unavailable, let the pool through
          return { pool: pool.pool, check: { confirmed: true, reason: `Dip check unavailable: ${error.message}` } };
        }
      }),
    );
    const dipCheckByPool = new Map(dipChecks.map((e) => [e.pool, e.check]));
    const before = eligible.length;
    eligible.splice(0, eligible.length, ...eligible.filter((pool) => {
      const check = dipCheckByPool.get(pool.pool);
      pool.dip_check = check || null;
      if (!check || check.confirmed) return true;
      pushFilteredReason(filteredOut, pool, `dip filter: ${check.reason}`);
      log("screening", `Dip filter rejected ${pool.name || pool.pool.slice(0, 8)}: ${check.reason}`);
      return false;
    }));
    if (eligible.length < before) {
      log("screening", `Dip filter removed ${before - eligible.length} candidate(s) (need ≥${minDipPct}% below ${dipLookback}-candle high)`);
    }
  }

  return {
    candidates: eligible,
    total_eligible: eligible.length,
    total_screened: discovery.total ?? pools.length,
    source,
    filtered_examples: filteredOut.slice(0, 3),
    stage_counts: discovery.stage_counts ? { ranked: discovery.total, ...discovery.stage_counts } : null,
    all_filtered: filteredOut,
  };
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const pool = await fetchPoolDiscoveryDetail({ poolAddress: pool_address, timeframe });

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    tvl: round(p.tvl),
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    fee_active_tvl_ratio: p.fee_active_tvl_ratio != null ? fix(p.fee_active_tvl_ratio, 4) : null,
    volatility: fix(p.volatility, 4),
    volatility_timeframe: p.volatility_timeframe || getVolatilityTimeframe(config.screening.timeframe),

    // Per-timeframe breakdown (populated when sourceTimeframe !== volatilityTimeframe)
    ...(p.volatility_timeframe && p.volatility_timeframe !== config.screening.timeframe ? {
      [`volume_${config.screening.timeframe}`]: round(p[`volume_${config.screening.timeframe}`] ?? null),
      [`volume_${p.volatility_timeframe}`]: round(p[`volume_${p.volatility_timeframe}`] ?? null),
      [`volatility_${config.screening.timeframe}`]: fix(p[`volatility_${config.screening.timeframe}`] ?? null, 4),
      [`volatility_${p.volatility_timeframe}`]: fix(p[`volatility_${p.volatility_timeframe}`] ?? null, 4),
    } : {}),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,
    launchpad: getPoolLaunchpad(p),

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,
    discord_signal: Boolean(p.discord_signal),
    discord_signal_count: p.discord_signal_count || 0,
    discord_signal_seen_count: p.discord_signal_seen_count || 0,
    discord_signal_last_seen_at: p.discord_signal_last_seen_at || null,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,

    // Liquidity-relative + LP-activity metrics (Degen Score inputs)
    volume_active_tvl_ratio: p.volume_active_tvl_ratio != null ? fix(p.volume_active_tvl_ratio, 4) : null,
    unique_lps: p.unique_lps,
    unique_lps_change_pct: fix(p.unique_lps_change_pct, 1),
    positions_created: p.positions_created,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  const value = numeric(n);
  return value != null ? Number(value.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    pool: pool.pool || null,
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
