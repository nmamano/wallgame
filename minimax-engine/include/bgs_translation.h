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

template <int R, int C>
Move ParseStdMove(const std::string& notation, const Situation<R, C>& sit) {
  Move m;
  m.token_change = 0;
  m.edges[0] = -1;
  m.edges[1] = -1;
  if (notation == "---") return m;  // pass / no-op

  const int src = sit.tokens[sit.turn];
  int n_edges = 0;
  size_t start = 0;
  while (true) {
    size_t dot = notation.find('.', start);
    std::string tok = (dot == std::string::npos) ? notation.substr(start)
                                                 : notation.substr(start, dot - start);
    if (tok.empty()) throw std::runtime_error("empty action in move: '" + notation + "'");
    char head = tok[0];
    if (head == 'C' || head == 'c') {
      RC rc = CellFromStd(tok.substr(1), R);
      if (rc.row < 0 || rc.row >= R || rc.col < 0 || rc.col >= C)
        throw std::runtime_error("cat target out of bounds: '" + tok + "'");
      m.token_change = NodeAt(C, rc.row, rc.col) - src;
    } else if (head == '>' || head == '^') {
      RC rc = CellFromStd(tok.substr(1), R);
      if (n_edges >= 2) throw std::runtime_error("too many walls: '" + notation + "'");
      m.edges[n_edges++] = WallToEdge(rc.row, rc.col, head == '>', R, C);
    } else if (head == 'M' || head == 'm') {
      throw std::runtime_error("mouse action not supported in classic: '" + tok + "'");
    } else {
      throw std::runtime_error("unknown action: '" + tok + "'");
    }
    if (dot == std::string::npos) break;
    start = dot + 1;
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
