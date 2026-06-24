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

  // --- SYNTAX / fake-edge / structural rejections (ParseActions) ------------
  auto throws_parse = [&](const std::string& n, const std::string& why) {
    bool threw = false;
    try {
      ParseActions(n, R, C);
    } catch (const std::exception&) {
      threw = true;
    }
    check(threw, "ParseActions rejects " + why + " ('" + n + "')");
  };
  throws_parse(">h8", "vertical wall in last column (fake edge)");
  throws_parse("^a8", "horizontal wall in top row (fake edge)");
  throws_parse("Mb8", "mouse action in classic");
  throws_parse("Cb8.Cc8", "multiple cat actions");
  throws_parse("Ca8.>a8.^b7", "more than two actions");
  throws_parse("Zz9", "unknown action");
  throws_parse("Cz9", "cat column out of range");

  // --- LEGALITY rejections / acceptances (ParseAndValidate) ------------------
  // sit is the 8x8 classic start: P1 (turn 0) at a8.
  auto throws_validate = [&](const std::string& n, const std::string& why) {
    bool threw = false;
    try {
      ParseAndValidate(n, sit);
    } catch (const std::exception&) {
      threw = true;
    }
    check(threw, "ParseAndValidate rejects " + why + " ('" + n + "')");
  };
  auto accepts_validate = [&](const std::string& n) {
    bool ok = true;
    try {
      ParseAndValidate(n, sit);
    } catch (const std::exception& e) {
      ok = false;
      std::cerr << "  (unexpected reject: '" << n << "' -> " << e.what() << ")\n";
    }
    check(ok, "ParseAndValidate accepts legal '" + n + "'");
  };
  throws_validate("Ca8", "explicit cat no-op");
  throws_validate("Cd8", "pawn jump of 3 from start");
  throws_validate(">a8.>a8", "duplicate wall in one move");
  accepts_validate("---");
  accepts_validate("Cc8");      // 2-step pawn walk
  accepts_validate("Cb8.>a8");  // walk + vertical wall

  // Blocked two-step: a wall between b8 and c8 makes a8->c8 need >2 steps, so
  // the otherwise-legal "Cc8" must be rejected (distance is over the ACTIVE graph).
  {
    Situation<R, C> blocked = sit;                       // P1 at a8
    blocked.G.DeactivateEdge(WallToEdge(0, 1, true, R, C));  // vertical wall b8|c8
    bool threw = false;
    try {
      ParseAndValidate("Cc8", blocked);
    } catch (const std::exception&) {
      threw = true;
    }
    check(threw, "ParseAndValidate rejects a two-step blocked by a wall (Cc8)");
  }

  // --- edge-index side (the reverse surface MoveToStdNotation emits through) --
  // Every REAL edge round-trips e -> wall -> e; every FAKE edge in range rejects
  // (covers fake right-column AND fake bottom-row graph edges).
  {
    int real = 0, fake = 0;
    for (int e = 0; e < NumRealAndFakeEdges(R, C); ++e) {
      if (IsRealEdge(R, C, e)) {
        WallRC w = EdgeToWall(e, R, C);
        check(WallToEdge(w.row, w.col, w.vertical, R, C) == e,
              "edge round-trip e=" + std::to_string(e));
        ++real;
      } else {
        bool threw = false;
        try {
          EdgeToWall(e, R, C);
        } catch (const std::exception&) {
          threw = true;
        }
        check(threw, "EdgeToWall rejects fake edge e=" + std::to_string(e));
        ++fake;
      }
    }
    check(real == R * (C - 1) + (R - 1) * C, "real edge count");
    check(fake > 0, "fake edges exist and were all rejected");
  }

  if (g_fail == 0)
    std::cout << "translation_test: ALL PASS\n";
  else
    std::cerr << "translation_test: " << g_fail << " FAILURES\n";
  return g_fail == 0 ? 0 : 1;
}
