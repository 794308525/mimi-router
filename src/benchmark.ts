import type { BenchmarkProviderResult, BenchmarkRun, BenchmarkWeights } from "./types";

export const BENCHMARK_MODES = {
  balanced: { label: "均衡推荐", weights: { price: 40, latency: 45, success: 15 } },
  value: { label: "性价比优先", weights: { price: 55, latency: 30, success: 15 } },
  speed: { label: "速度优先", weights: { price: 25, latency: 60, success: 15 } },
  stable: { label: "稳定优先", weights: { price: 25, latency: 30, success: 45 } },
} as const;

export type BenchmarkMode = keyof typeof BENCHMARK_MODES | "custom";

export type ScoredBenchmarkResult = BenchmarkProviderResult & {
  successful_samples: number;
  success_rate: number;
  average_first_token_ms: number | null;
  effective_first_token_ms: number | null;
  effective_multiplier: number | null;
  score: number | null;
};

export function scoreBenchmark(
  run: BenchmarkRun,
  weights: BenchmarkWeights,
  targetFirstTokenMs: number,
): ScoredBenchmarkResult[] {
  const raw = run.providers.map((provider) => {
    const successful = provider.samples.filter((sample) => sample.ok && sample.first_token_ms != null);
    const failed = provider.samples.filter((sample) => !sample.ok);
    const total = provider.samples.length;
    const successRate = total ? successful.length / total : 0;
    const averageFirstToken = successful.length
      ? average(successful.map((sample) => sample.first_token_ms as number))
      : null;
    const averageFailureDuration = failed.length
      ? average(failed.map((sample) => sample.duration_ms))
      : 0;
    const retryPenalty = successRate > 0
      ? ((1 - successRate) / successRate) * (averageFailureDuration + 1000)
      : 0;
    return {
      ...provider,
      successful_samples: successful.length,
      success_rate: successRate,
      average_first_token_ms: averageFirstToken,
      effective_first_token_ms: averageFirstToken == null ? null : averageFirstToken + retryPenalty,
      effective_multiplier: successRate > 0 ? provider.cost_multiplier / successRate : null,
      score: null,
    } satisfies ScoredBenchmarkResult;
  });
  const effectiveMultipliers = raw
    .map((item) => item.effective_multiplier)
    .filter((value): value is number => value != null);
  const minimumMultiplier = effectiveMultipliers.length ? Math.min(...effectiveMultipliers) : 1;
  const weightTotal = weights.price + weights.latency + weights.success;

  return raw.map((item) => {
    if (item.effective_multiplier == null || item.effective_first_token_ms == null || weightTotal <= 0) {
      return item;
    }
    const priceScore = item.effective_multiplier === 0
      ? 1
      : minimumMultiplier / item.effective_multiplier;
    const latencyScore = targetFirstTokenMs
      / Math.max(targetFirstTokenMs, item.effective_first_token_ms);
    return {
      ...item,
      score: (
        priceScore * weights.price
        + latencyScore * weights.latency
        + item.success_rate * weights.success
      ) / weightTotal * 100,
    };
  }).sort((left, right) => {
    if (left.score == null && right.score != null) return 1;
    if (left.score != null && right.score == null) return -1;
    if (left.score !== right.score) return (right.score ?? 0) - (left.score ?? 0);
    if (left.effective_first_token_ms !== right.effective_first_token_ms) {
      return (left.effective_first_token_ms ?? Infinity) - (right.effective_first_token_ms ?? Infinity);
    }
    if (left.effective_multiplier !== right.effective_multiplier) {
      return (left.effective_multiplier ?? Infinity) - (right.effective_multiplier ?? Infinity);
    }
    if (left.success_rate !== right.success_rate) return right.success_rate - left.success_rate;
    return left.provider_name.localeCompare(right.provider_name, "zh-CN");
  });
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
