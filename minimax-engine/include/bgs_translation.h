#ifndef BGS_TRANSLATION_H_
#define BGS_TRANSLATION_H_

// Translation between wallgame's wire representation and this engine's internal
// representation, for the V3 bot protocol wrapper.
//
//   wallgame wire            engine internal
//   --------------------     ----------------------------------
//   cell [row,col]           node = row*C + col   (both (0,0)=top-left)
//   std-notation move        Move{token_change, edges[2]}
//   wall {cell,orientation}  graph edge index
//
// EXACT wall<->edge bijection (see plans/minimax-ai-loop.md "Resources"):
//   vertical   {cell:[r,c]} <-> EdgeRight(node(r,c))      (valid c < C-1)
//   horizontal {cell:[r,c]} <-> EdgeBelow(node(r-1,c))    (valid r > 0)  <-- the off-by-one trap
//
// IMPORTANT: nothing here writes to std::cout. Parse failures throw
// std::runtime_error (the wrapper turns them into JSON error responses), so a
// malformed apply_move can never corrupt the JSON-lines stdout.

#include <array>
#include <cctype>
#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

#include "graph.h"
#include "move.h"
#include "situation.h"

namespace wallwars {
namespace bgs {

// ---- cells <-> standard notation -------------------------------------------
// Standard notation: column letter ('a'+col), then 1-based row counted from the
// BOTTOM (rowNum = totalRows - row). Mirrors shared/domain/standard-notation.ts.

struct RC {
  int row;
  int col;
};

inline std::string CellToStd(int row, int col, int total_rows) {
  std::string s;
  s += static_cast<char>('a' + col);
  s += std::to_string(total_rows - row);
  return s;
}

inline RC CellFromStd(const std::string& s, int total_rows) {
  if (s.size() < 2 || !std::isalpha(static_cast<unsigned char>(s[0])))
    throw std::runtime_error("bad cell notation: '" + s + "'");
  int col = std::tolower(static_cast<unsigned char>(s[0])) - 'a';
  for (size_t i = 1; i < s.size(); ++i)
    if (!std::isdigit(static_cast<unsigned char>(s[i])))
      throw std::runtime_error("bad cell notation: '" + s + "'");
  int row_num = std::stoi(s.substr(1));
  return {total_rows - row_num, col};
}

// ---- wall <-> edge bijection -----------------------------------------------

inline int WallToEdge(int row, int col, bool vertical, int R, int C) {
  if (vertical) {
    if (row < 0 || row >= R || col < 0 || col >= C - 1)
      throw std::runtime_error("vertical wall out of range");
    return EdgeRight(C, NodeAt(C, row, col));
  }
  if (row <= 0 || row >= R || col < 0 || col >= C)
    throw std::runtime_error("horizontal wall out of range");
  return EdgeBelow(R, C, NodeAt(C, row - 1, col));
}

struct WallRC {
  int row;
  int col;
  bool vertical;
};

inline WallRC EdgeToWall(int e, int R, int C) {
  if (!IsRealEdge(R, C, e)) throw std::runtime_error("not a real edge");
  if (e % 2 == 0) {  // EdgeRight(v) == 2*v  -> vertical wall at base cell
    int base = e / 2;
    return {Row(C, base), Col(C, base), true};
  }
  // EdgeBelow(v) == 2*v+1 -> wall below base node == above cell (base_row + 1)
  int base = (e - 1) / 2;
  return {Row(C, base) + 1, Col(C, base), false};
}

// ---- standard-notation move <-> engine Move --------------------------------

// Structured result of parsing a standard-notation move (SYNTAX only).
struct ParsedMove {
  bool has_cat = false;
  int cat_dst = -1;             // node index, valid iff has_cat
  std::array<int, 2> walls = {-1, -1};
  int wall_count = 0;
};

// Parse SYNTAX + STRUCTURE only (no game legality): at most 2 actions, at most
// one cat action, mouse rejected, cells/walls in range (WallToEdge rejects fake
// edges). Throws std::runtime_error on malformed input. "---" -> empty.
inline ParsedMove ParseActions(const std::string& notation, int R, int C) {
  ParsedMove p;
  if (notation == "---") return p;
  int total = 0;
  size_t start = 0;
  while (true) {
    size_t dot = notation.find('.', start);
    std::string tok = (dot == std::string::npos) ? notation.substr(start)
                                                 : notation.substr(start, dot - start);
    if (tok.empty()) throw std::runtime_error("empty action in move: '" + notation + "'");
    if (++total > 2) throw std::runtime_error("too many actions (max 2): '" + notation + "'");
    char head = tok[0];
    if (head == 'C' || head == 'c') {
      if (p.has_cat) throw std::runtime_error("multiple cat actions: '" + notation + "'");
      RC rc = CellFromStd(tok.substr(1), R);
      if (rc.row < 0 || rc.row >= R || rc.col < 0 || rc.col >= C)
        throw std::runtime_error("cat target out of bounds: '" + tok + "'");
      p.has_cat = true;
      p.cat_dst = NodeAt(C, rc.row, rc.col);
    } else if (head == '>' || head == '^') {
      RC rc = CellFromStd(tok.substr(1), R);
      int e = WallToEdge(rc.row, rc.col, head == '>', R, C);  // throws on fake/out-of-range
      if (p.wall_count >= 2) throw std::runtime_error("too many walls: '" + notation + "'");
      p.walls[p.wall_count++] = e;
    } else if (head == 'M' || head == 'm') {
      throw std::runtime_error("mouse action not supported in classic: '" + tok + "'");
    } else {
      throw std::runtime_error("unknown action: '" + tok + "'");
    }
    if (dot == std::string::npos) break;
    start = dot + 1;
  }
  return p;
}

// SYNTAX-only parse -> engine Move (no legality). Used by notation round-trips.
template <int R, int C>
Move ParseStdMove(const std::string& notation, const Situation<R, C>& sit) {
  ParsedMove p = ParseActions(notation, R, C);
  Move m;
  m.token_change = p.has_cat ? (p.cat_dst - sit.tokens[sit.turn]) : 0;
  m.edges[0] = p.wall_count > 0 ? p.walls[0] : -1;
  m.edges[1] = p.wall_count > 1 ? p.walls[1] : -1;
  return m;
}

// Parse AND validate legality against `sit` (wallgame-compatible: 0/1/2 actions).
// Validation is SEQUENTIAL on a clone so walls see the post-pawn position and
// each other. Throws std::runtime_error on any illegal move; never mutates `sit`
// and never calls the engine's printing helpers. Returns the engine Move.
template <int R, int C>
Move ParseAndValidate(const std::string& notation, const Situation<R, C>& sit) {
  ParsedMove p = ParseActions(notation, R, C);
  const int turn = sit.turn;
  const int src = sit.tokens[turn];
  Situation<R, C> clone = sit;  // validate on a clone

  Move m;
  m.token_change = 0;
  m.edges[0] = -1;
  m.edges[1] = -1;

  if (p.has_cat) {
    const int dst = p.cat_dst;
    if (dst == src) throw std::runtime_error("cat no-op (use --- to pass)");
    int d = clone.G.Distance(src, dst);  // shortest path through ACTIVE edges
    if (d < 1 || d > 2)
      throw std::runtime_error("pawn destination not reachable in 1-2 steps");
    clone.tokens[turn] = static_cast<int8_t>(dst);  // post-pawn for wall checks
    m.token_change = dst - src;
  }

  for (int i = 0; i < p.wall_count; ++i) {
    int e = p.walls[i];
    if (!clone.G.edges[e]) throw std::runtime_error("wall already built/inactive");
    if (!clone.CanDeactivateEdge(e))
      throw std::runtime_error("wall would disconnect a player from goal");
    clone.G.DeactivateEdge(e);  // sequential: a later wall sees this one applied
    m.edges[i] = e;
  }
  return m;
}

template <int R, int C>
std::string MoveToStdNotation(const Move& move, const Situation<R, C>& sit) {
  const int src = sit.tokens[sit.turn];
  std::string cat_str;
  std::vector<std::string> verticals, horizontals;

  if (move.token_change != 0) {
    int dst = src + move.token_change;
    cat_str = std::string("C") + CellToStd(Row(C, dst), Col(C, dst), R);
  }
  for (int e : move.edges) {
    if (e == -1) continue;
    WallRC w = EdgeToWall(e, R, C);
    std::string s = (w.vertical ? ">" : "^") + CellToStd(w.row, w.col, R);
    (w.vertical ? verticals : horizontals).push_back(s);
  }

  // Order cat, then vertical, then horizontal walls (mirrors the canonical
  // sort in standard-notation.ts; parsing is order-independent regardless).
  std::vector<std::string> parts;
  if (!cat_str.empty()) parts.push_back(cat_str);
  parts.insert(parts.end(), verticals.begin(), verticals.end());
  parts.insert(parts.end(), horizontals.begin(), horizontals.end());
  if (parts.empty()) return "---";

  std::string out;
  for (size_t i = 0; i < parts.size(); ++i) {
    if (i) out += ".";
    out += parts[i];
  }
  return out;
}

// ---- eval: engine side-to-move score -> P1-perspective [-1, 1] -------------
// p1Raw = (turn==0) ? rootEval : -rootEval, then deterministic tanh squash.
// kEvalScale is mechanism-only here; golden-tuned in slice 2b.
inline double EvalToP1(int root_eval, int turn, double scale = 6.0) {
  double p1_raw = (turn == 0) ? static_cast<double>(root_eval)
                              : -static_cast<double>(root_eval);
  double v = std::tanh(p1_raw / scale);
  if (v > 1.0) v = 1.0;
  if (v < -1.0) v = -1.0;
  return v;
}

}  // namespace bgs
}  // namespace wallwars

#endif  // BGS_TRANSLATION_H_
