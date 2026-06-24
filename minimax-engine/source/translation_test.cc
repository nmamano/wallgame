// Targeted translation tests for the BGS wrapper (slice 1b subset).
// Proves the wall<->edge bijection (including the horizontal off-by-one trap)
// and the notation/move conversions. EXHAUSTIVE coverage is slice 2a.
//
// Judges by exact values, not the UI. Exits non-zero on any failure.

#include <iostream>
#include <string>

#include "bgs_translation.h"
#include "graph.h"
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

int main() {
  constexpr int R = 8, C = 8;

  // --- cell <-> standard notation -------------------------------------------
  check(CellToStd(0, 0, R) == "a8", "CellToStd(0,0)=a8");
  check(CellToStd(7, 7, R) == "h1", "CellToStd(7,7)=h1");
  check(CellToStd(0, 7, R) == "h8", "CellToStd(0,7)=h8");
  check(CellToStd(7, 0, R) == "a1", "CellToStd(7,0)=a1");
  {
    RC a = CellFromStd("a8", R);
    check(a.row == 0 && a.col == 0, "CellFromStd a8=(0,0)");
    RC h = CellFromStd("h1", R);
    check(h.row == 7 && h.col == 7, "CellFromStd h1=(7,7)");
  }

  // --- wall <-> edge: explicit values + the off-by-one trap ------------------
  check(WallToEdge(3, 2, /*vertical=*/true, R, C) == EdgeRight(C, NodeAt(C, 3, 2)),
        "vertical[3,2] == EdgeRight(node(3,2))");
  // horizontal anchor MUST be EdgeBelow(node(r-1,c)), NOT node(r,c).
  check(WallToEdge(3, 2, /*vertical=*/false, R, C) == EdgeBelow(R, C, NodeAt(C, 2, 2)),
        "horizontal[3,2] == EdgeBelow(node(2,2))");
  check(WallToEdge(3, 2, /*vertical=*/false, R, C) != EdgeBelow(R, C, NodeAt(C, 3, 2)),
        "horizontal[3,2] is NOT EdgeBelow(node(3,2)) [off-by-one trap]");

  // --- wall round-trip over all valid anchors (both orientations) -----------
  int vcount = 0, hcount = 0;
  for (int r = 0; r < R; ++r) {
    for (int c = 0; c < C; ++c) {
      if (c < C - 1) {  // vertical valid except last column
        int e = WallToEdge(r, c, true, R, C);
        WallRC w = EdgeToWall(e, R, C);
        check(w.vertical && w.row == r && w.col == c,
              "vertical round-trip [" + std::to_string(r) + "," + std::to_string(c) + "]");
        ++vcount;
      }
      if (r > 0) {  // horizontal valid except top row
        int e = WallToEdge(r, c, false, R, C);
        WallRC w = EdgeToWall(e, R, C);
        check(!w.vertical && w.row == r && w.col == c,
              "horizontal round-trip [" + std::to_string(r) + "," + std::to_string(c) + "]");
        ++hcount;
      }
    }
  }
  check(vcount == R * (C - 1), "vertical anchor count");
  check(hcount == (R - 1) * C, "horizontal anchor count");

  // --- move <-> notation round-trips (pawn, vertical wall, horizontal wall) --
  Situation<R, C> sit;
  sit.SetStartingSituation();  // P1 (turn 0) at a8 == node(0,0)
  auto roundtrip = [&](const std::string& notation) {
    Move m = ParseStdMove(notation, sit);
    std::string back = MoveToStdNotation(m, sit);
    check(back == notation, "move round-trip '" + notation + "' -> '" + back + "'");
  };
  roundtrip("Cc8");        // 2-step pawn walk as a single cat action
  roundtrip("Cb8.>a8");    // walk + vertical wall (edge 0)
  roundtrip("Cb8.^b7");    // walk + horizontal wall (anchor [1,1], r>0; off-by-one path)

  if (g_fail == 0)
    std::cout << "translation_test: ALL PASS\n";
  else
    std::cerr << "translation_test: " << g_fail << " FAILURES\n";
  return g_fail == 0 ? 0 : 1;
}
