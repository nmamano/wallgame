// Golden eval tests for the BGS wrapper (slice 2b).
//
// Backbone = pure-conversion tests (deterministic). Plus a few near-forced
// engine-based positions asserting only SIGN BANDS (tolerant), per the
// plan-gate. Judges by values, not the UI. Exits non-zero on any failure.

#include <cmath>
#include <iostream>
#include <string>

#include "bgs_translation.h"
#include "graph.h"
#include "negamax.h"
#include "situation.h"

using namespace wallwars;
using namespace wallwars::bgs;

static int g_fail = 0;
static void check(bool cond, const std::string& msg) {
  if (!cond) {
    std::cerr << "FAIL: " << msg << "\n";
    ++g_fail;
  }
}
static std::string s(double v) { return std::to_string(v); }

int main() {
  constexpr int R = 8, C = 8;

  // ===== Pure: TerminalEvalP1 =====
  check(TerminalEvalP1(0) == 1.0, "TerminalEvalP1(P1 win) == +1");
  check(TerminalEvalP1(1) == -1.0, "TerminalEvalP1(P2 win) == -1");
  check(TerminalEvalP1(2) == 0.0, "TerminalEvalP1(draw) == 0");
  {
    bool threw = false;
    try { TerminalEvalP1(5); } catch (const std::exception&) { threw = true; }
    check(threw, "TerminalEvalP1 throws on unexpected winner");
  }

  // ===== Pure: EvalToP1 sign / odd symmetry / monotonic / range / saturation =
  check(EvalToP1(10, 0) > 0, "turn0 positive raw -> positive");
  check(EvalToP1(10, 1) < 0, "turn1 positive raw -> negative (P2 advantage)");
  check(std::abs(EvalToP1(7, 0) + EvalToP1(7, 1)) < 1e-12, "odd symmetry: f(x,0) == -f(x,1)");
  check(EvalToP1(0, 0) == 0.0, "raw 0 -> 0");

  {  // monotonic increasing in raw for turn 0
    double prev = -2.0;
    bool mono = true;
    for (int r : {-16, -8, -4, 0, 4, 8, 16}) {
      double v = EvalToP1(r, 0);
      if (v <= prev) mono = false;
      prev = v;
    }
    check(mono, "EvalToP1 strictly increasing in raw (turn 0)");
  }

  check(EvalToP1(100000, 0) <= 1.0 && EvalToP1(100000, 0) > 0.99, "high raw saturates to ~+1, clamped <=1");
  check(EvalToP1(-100000, 0) >= -1.0 && EvalToP1(-100000, 0) < -0.99, "low raw saturates to ~-1, clamped >=-1");
  check(EvalToP1(999, 0) > 0.99, "forced-win raw (>=999) saturates ~+1");
  check(std::abs(EvalToP1(8, 0) - std::tanh(1.0)) < 1e-12, "scale 8.0 applied (raw 8 -> tanh(1))");
  {
    bool threw = false;
    try { EvalToP1(4, 0, -1.0); } catch (const std::exception&) { threw = true; }
    check(threw, "EvalToP1 rejects scale <= 0");
  }

  // ===== Terminal positions via Winner() =====
  {
    Situation<R, C> sit;
    sit.SetStartingSituation();
    sit.tokens[0] = static_cast<int8_t>(NodeAt(C, 7, 7));  // P1 on its goal corner
    check(sit.IsGameOver(), "P1 on goal -> game over");
    check(sit.Winner() == 0, "P1 reached goal -> Winner()==0");
    check(TerminalEvalP1(sit.Winner()) == 1.0, "P1 terminal -> +1");
  }
  {
    Situation<R, C> sit;
    sit.SetStartingSituation();
    sit.tokens[1] = static_cast<int8_t>(NodeAt(C, 7, 0));  // P2 on its goal corner
    check(sit.Winner() == 1, "P2 reached goal -> Winner()==1");
    check(TerminalEvalP1(sit.Winner()) == -1.0, "P2 terminal -> -1");
  }
  for (int distance : {1, 2}) {
    Situation<R, C> sit;
    sit.SetStartingSituation();
    sit.tokens[0] = static_cast<int8_t>(Goals(R, C)[0]);
    sit.tokens[1] = static_cast<int8_t>(Goals(R, C)[1] + distance);
    check(sit.Winner() == 0,
          "P0 goal wins when opponent distance is " + std::to_string(distance));
    check(TerminalEvalP1(sit.Winner()) == 1.0,
          "P0 removed-draw terminal evaluates to +1 at distance " +
              std::to_string(distance));
  }
  {
    Situation<3, 3> shared_server_position;
    shared_server_position.SetStartingSituation();
    shared_server_position.tokens = {NodeAt(3, 2, 2), NodeAt(3, 1, 1)};
    check(shared_server_position.Winner() == 0,
          "SP-3x3 Cb2 Cb2 Cc1 ends in a P1 capture");
    check(TerminalEvalP1(shared_server_position.Winner()) == 1.0,
          "SP-3x3 terminal evaluates to +1 for P1");
  }

  // ===== Engine-based sign bands (few, near-forced, tolerant) =====
  Negamax<R, C> eng;
  {  // P1 one step from goal, P1 to move -> winning -> eval strongly positive
    Situation<R, C> sit;
    sit.SetStartingSituation();
    sit.tokens[0] = static_cast<int8_t>(NodeAt(C, 7, 6));  // a step from (7,7)
    sit.turn = 0;
    eng.GetMove(sit, 100);
    double e = EvalToP1(eng.LastRootEval(), sit.turn);
    check(e > 0.5, "P1 near-win -> eval > 0.5 (got " + s(e) + ")");
  }
  {
    Situation<4, 4> sit;
    sit.SetStartingSituation();
    sit.tokens = {13, 8};
    sit.turn = 0;
    Negamax<4, 4> removed_draw_engine;
    Move const selected = removed_draw_engine.GetMove(sit, 1000);
    Situation<4, 4> after = sit;
    after.ApplyMove(selected);
    check(after.tokens[0] == Goals(4, 4)[0] && after.Winner() == 0,
          "GetMove selects the removed-draw P1 goal move");
    check(removed_draw_engine.LastRootEval() >= Negamax<4, 4>::GameOverEval(),
          "removed-draw root eval reaches GameOverEval (got " +
              std::to_string(removed_draw_engine.LastRootEval()) + ")");
  }
  {  // P2 one step from goal, P2 to move -> P1 losing -> eval strongly negative
    Situation<R, C> sit;
    sit.SetStartingSituation();
    sit.tokens[1] = static_cast<int8_t>(NodeAt(C, 7, 1));  // a step from (7,0)
    sit.turn = 1;
    eng.GetMove(sit, 100);
    double e = EvalToP1(eng.LastRootEval(), sit.turn);
    check(e < -0.5, "P2 near-win -> eval < -0.5 (got " + s(e) + ")");
  }
  {  // symmetric start -> bounded neutral
    Situation<R, C> sit;
    sit.SetStartingSituation();
    eng.GetMove(sit, 100);
    double e = EvalToP1(eng.LastRootEval(), sit.turn);
    check(std::abs(e) < 0.5, "symmetric start -> |eval| < 0.5 (got " + s(e) + ")");
  }

  if (g_fail == 0)
    std::cout << "eval_test: ALL PASS\n";
  else
    std::cerr << "eval_test: " << g_fail << " FAILURES\n";
  return g_fail == 0 ? 0 : 1;
}
