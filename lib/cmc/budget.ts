// Hard credit cap per server process and UTC day. [CMC Hackathon — C6-A]
//
// The TTL cache bounds credit use while one process keeps running; this cap
// also bounds it if something goes wrong (a bug, unexpected cache misses).
// Every CMC request that costs credits must reserve them here FIRST; when the
// day's cap would be exceeded, no request is sent (the caller serves stale data
// or degrades). Reservations are counted at attempt time, failed or not, so the
// count never under-reports.
//
// Scope, stated plainly: the counter lives in memory, so it limits ONE server
// process. N concurrent processes (serverless instances) can spend up to
// N x cap per day, and a restart starts a new count. The plan-wide limit is
// enforced by CMC itself (requests are refused once the monthly credits are used).

export const DAILY_CREDIT_CAP = 200;

const DAY_MS = 86_400_000;

export class CreditBudget {
  private readonly cap: number;
  private readonly now: () => number;
  private day = -1;
  private used = 0;

  constructor(cap: number = DAILY_CREDIT_CAP, now: () => number = Date.now) {
    if (!(Number.isInteger(cap) && cap >= 0)) throw new RangeError("invalid credit cap");
    this.cap = cap;
    this.now = now;
  }

  private roll(): void {
    const d = Math.floor(this.now() / DAY_MS);
    if (d !== this.day) {
      this.day = d;
      this.used = 0;
    }
  }

  /** Reserve `credits`; false (and nothing reserved) when the day's cap would be exceeded. */
  tryReserve(credits: number): boolean {
    this.roll();
    if (!(Number.isInteger(credits) && credits >= 0)) return false;
    if (this.used + credits > this.cap) return false;
    this.used += credits;
    return true;
  }

  /** ms until the counter resets (next 00:00 UTC). */
  msUntilReset(): number {
    const t = this.now();
    return (Math.floor(t / DAY_MS) + 1) * DAY_MS - t;
  }

  get usedToday(): number {
    this.roll();
    return this.used;
  }
}
