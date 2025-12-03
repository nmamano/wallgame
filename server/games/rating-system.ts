// Implements the Glicko2 rating system
// https://en.wikipedia.org/wiki/Glicko_rating_system
// It is a more modern variant of ELO.

// =======================================================
// Public API
// =======================================================

export enum Outcome {
  Win = 1,
  Loss = 0,
  Tie = 0.5,
}

export interface RatingSystemConfig {
  defaultRating: number;
  defaultDeviation: number;
  defaultVolatility: number;
  tau: number;
}

const defaultConfig: RatingSystemConfig = {
  // The baseline rating value. Not mandated by the Glicko-2 paper;
  // 1500 is simply the most widely used midpoint across implementations.
  defaultRating: 1500,

  // Rating Deviation (RD): a measure of uncertainty in the player's rating.
  // Higher RD → system is less sure of the player's true skill.
  // 350 is the recommended initial RD in the Glicko-2 paper.
  defaultDeviation: 350,

  // Volatility: how rapidly the player's rating is expected to change.
  // Higher volatility → the system believes the player's skill can swing more.
  // 0.06 is the example initial value used in the Glicko-2 paper.
  defaultVolatility: 0.06,

  // τ ("tau"): controls how quickly volatility itself is allowed to adjust.
  // Lower τ → volatility changes slowly → ratings become more conservative.
  // The Glicko-2 paper recommends values in the range 0.3 to 1.2.
  tau: 0.5,
};

export type RatingState = Readonly<{
  rating: number;
  deviation: number;
  volatility: number;
}>;

// Factory to create an isolated rating system with its own config
export function createRatingSystem(overrides?: Partial<RatingSystemConfig>) {
  const config: RatingSystemConfig = { ...defaultConfig, ...overrides };

  function initialRating(): RatingState {
    return {
      rating: config.defaultRating,
      deviation: config.defaultDeviation,
      volatility: config.defaultVolatility,
    };
  }

  function updateAfterGame(
    player: RatingState,
    opponent: RatingState,
    outcome: Outcome,
  ): RatingState {
    const p = new Player({
      config,
      rating: player.rating,
      deviation: player.deviation,
      volatility: player.volatility,
    });

    const o = new Player({
      config,
      rating: opponent.rating,
      deviation: opponent.deviation,
      volatility: opponent.volatility,
    });

    p.addResult(o, outcome);
    p.updateRating();

    return {
      rating: p.rating,
      deviation: p.ratingDeviation,
      volatility: p.volatility,
    };
  }

  function complementOutcome(outcome: Outcome): Outcome {
    switch (outcome) {
      case Outcome.Win:
        return Outcome.Loss;
      case Outcome.Loss:
        return Outcome.Win;
      case Outcome.Tie:
        return Outcome.Tie;
    }
  }

  function updateBothAfterGame(
    a: RatingState,
    b: RatingState,
    outcomeForA: Outcome,
  ): { a: RatingState; b: RatingState } {
    const pa = new Player({
      config,
      rating: a.rating,
      deviation: a.deviation,
      volatility: a.volatility,
    });

    const pb = new Player({
      config,
      rating: b.rating,
      deviation: b.deviation,
      volatility: b.volatility,
    });

    pa.addResult(pb, outcomeForA);
    pb.addResult(pa, complementOutcome(outcomeForA));

    pa.updateRating();
    pb.updateRating();

    return {
      a: {
        rating: pa.rating,
        deviation: pa.ratingDeviation,
        volatility: pa.volatility,
      },
      b: {
        rating: pb.rating,
        deviation: pb.ratingDeviation,
        volatility: pb.volatility,
      },
    };
  }

  return {
    config,
    initialRating,
    updateAfterGame,
    updateBothAfterGame,
  };
}

// Default, ready-to-use rating system (uses defaultConfig)
export const defaultRatingSystem = createRatingSystem();

// Backwards-compatible convenience exports
export function initialRating(): RatingState {
  return defaultRatingSystem.initialRating();
}

export function newRatingAfterGame(
  player: RatingState,
  opponent: RatingState,
  outcome: Outcome,
): RatingState {
  return defaultRatingSystem.updateAfterGame(player, opponent, outcome);
}

export function newRatingsAfterGame(
  a: RatingState,
  b: RatingState,
  outcomeForA: Outcome,
): { a: RatingState; b: RatingState } {
  return defaultRatingSystem.updateBothAfterGame(a, b, outcomeForA);
}

// =======================================================
// Internal implementation details
// (based on your original Player class)
// =======================================================

interface PlayerOptions {
  config: RatingSystemConfig;
  rating: number;
  deviation: number;
  volatility: number;
  opponentRatings?: number[];
  opponentRatingDeviations?: number[];
  outcomes?: Outcome[];
}

class Player {
  // 400 / ln(10), used for converting to/from the internal scale
  private static readonly scalingFactor = 400 / Math.log(10);

  private readonly config: RatingSystemConfig;

  private _opponentRatingDeviations: number[] = [];
  private _opponentRatings: number[] = [];
  private _outcomes: Outcome[] = [];
  private _rating: number; // internal scale
  private _ratingDeviation: number; // internal scale
  private _volatility: number;

  constructor({
    config,
    opponentRatingDeviations,
    opponentRatings,
    outcomes,
    rating,
    deviation: ratingDeviation,
    volatility,
  }: PlayerOptions) {
    this.config = config;

    // Convert to internal scale
    this._rating = (rating - this.config.defaultRating) / Player.scalingFactor;
    this._ratingDeviation = ratingDeviation / Player.scalingFactor;
    this._volatility = volatility;

    if (
      Array.isArray(opponentRatingDeviations) ||
      Array.isArray(opponentRatings) ||
      Array.isArray(outcomes)
    ) {
      const n = outcomes?.length ?? 0;
      if (
        n !== (opponentRatings?.length ?? 0) ||
        n !== (opponentRatingDeviations?.length ?? 0)
      ) {
        throw new Error(
          "opponentRatingDeviations, opponentRatings, outcomes must be of equal size",
        );
      }
      this._opponentRatingDeviations = opponentRatingDeviations ?? [];
      this._opponentRatings = opponentRatings ?? [];
      this._outcomes = outcomes ?? [];
    }
  }

  get opponentRatingDeviations(): number[] {
    return [...this._opponentRatingDeviations];
  }

  get opponentRatings(): number[] {
    return [...this._opponentRatings];
  }

  get outcomes(): Outcome[] {
    return [...this._outcomes];
  }

  // External scale
  get rating(): number {
    return this._rating * Player.scalingFactor + this.config.defaultRating;
  }

  // External scale
  get ratingDeviation(): number {
    return this._ratingDeviation * Player.scalingFactor;
  }

  get volatility(): number {
    return this._volatility;
  }

  addResult(opponent: Player, outcome: Outcome): void {
    this._opponentRatings.push(opponent._rating);
    this._opponentRatingDeviations.push(opponent._ratingDeviation);
    this._outcomes.push(outcome);
  }

  // Calculates the new rating and rating deviation for this player.
  updateRating(): void {
    if (!this.hasPlayed()) {
      this.preRatingDeviation();
      return;
    }

    const v = this.variance();
    const delta = this.delta(v);

    this._volatility = this.volatilityAlgorithm(v, delta);

    this.preRatingDeviation();

    this._ratingDeviation =
      1 / Math.sqrt(1 / this._ratingDeviation ** 2 + 1 / v);

    let tempSum = 0;
    for (let i = 0; i < this._opponentRatings.length; i++) {
      tempSum +=
        this.g(this._opponentRatingDeviations[i]) *
        (this._outcomes[i] -
          this.E(this._opponentRatings[i], this._opponentRatingDeviations[i]));
    }

    this._rating += this._ratingDeviation ** 2 * tempSum;

    this.cleanPreviousMatches();
  }

  private cleanPreviousMatches(): void {
    this._opponentRatings = [];
    this._opponentRatingDeviations = [];
    this._outcomes = [];
  }

  private hasPlayed(): boolean {
    return this._outcomes.length > 0;
  }

  private volatilityAlgorithm(v: number, delta: number): number {
    let A = Math.log(this._volatility ** 2);
    const f = this.fFactory(delta, v, A);
    const epsilon = 0.000001;

    let B: number;
    let k: number | undefined;

    if (delta ** 2 > this._ratingDeviation ** 2 + v) {
      B = Math.log(delta ** 2 - this._ratingDeviation ** 2 - v);
    } else {
      k = 1;
      while (f(A - k * this.config.tau) < 0) {
        k = k + 1;
      }
      B = A - k * this.config.tau;
    }

    let fA = f(A);
    let fB = f(B);

    let C: number;
    let fC: number;

    while (Math.abs(B - A) > epsilon) {
      C = A + ((A - B) * fA) / (fB - fA);
      fC = f(C);

      if (fC * fB < 0) {
        A = B;
        fA = fB;
      } else {
        fA = fA / 2;
      }

      B = C;
      fB = fC;
    }

    return Math.exp(A / 2);
  }

  // Step: "pre-rating period" deviation update
  private preRatingDeviation(): void {
    this._ratingDeviation = Math.sqrt(
      this._ratingDeviation ** 2 + this._volatility ** 2,
    );
  }

  // Estimated variance based on outcomes
  private variance(): number {
    let tempSum = 0;

    for (let i = 0; i < this._opponentRatings.length; i++) {
      const tempE = this.E(
        this._opponentRatings[i],
        this._opponentRatingDeviations[i],
      );

      tempSum +=
        this.g(this._opponentRatingDeviations[i]) ** 2 * tempE * (1 - tempE);
    }

    return 1 / tempSum;
  }

  private E(p2rating: number, p2ratingDeviation: number): number {
    return (
      1 / (1 + Math.exp(-this.g(p2ratingDeviation) * (this._rating - p2rating)))
    );
  }

  private g(ratingDeviation: number): number {
    return 1 / Math.sqrt(1 + (3 * ratingDeviation ** 2) / Math.PI ** 2);
  }

  private delta(v: number): number {
    let tempSum = 0;

    for (let i = 0; i < this._opponentRatings.length; i++) {
      tempSum +=
        this.g(this._opponentRatingDeviations[i]) *
        (this._outcomes[i] -
          this.E(this._opponentRatings[i], this._opponentRatingDeviations[i]));
    }

    return v * tempSum;
  }

  private fFactory(delta: number, v: number, a: number) {
    return (x: number): number => {
      const ex = Math.exp(x);
      const phi2 = this._ratingDeviation ** 2;
      const num = ex * (delta ** 2 - phi2 - v - ex);
      const den = 2 * (phi2 + v + ex) ** 2;
      const term = (x - a) / this.config.tau ** 2;

      return num / den - term;
    };
  }
}
