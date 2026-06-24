// V3 Bot Game Session engine wrapper for the classic minimax (negamax) AI.
//
// A long-lived process that speaks the wallgame V3 protocol over stdin/stdout
// as JSON-lines (one JSON object per line). It holds a Situation per bgsId and
// drives Negamax::GetMove. See plans/minimax-ai-loop.md (slice 1b).
//
// Scope (slice 1b): classic variant, 8x8 only. Synchronous, single-threaded.
//
// stdout is PROTOCOL ONLY. All diagnostics (incl. negamax search logs, now
// routed to std::cerr) go to stderr. Parse/validation errors become JSON error
// responses, never stdout text.
//
// Test-only tuning: --think-millis N or env MINIMAX_THINK_MILLIS=N overrides the
// per-move think time (production default ~3000ms). This is speed tuning for
// smoke/integration tests, NOT a difficulty tier.

#include <cstdlib>
#include <iostream>
#include <map>
#include <string>
#include <utility>

#include <nlohmann/json.hpp>

#include "bgs_translation.h"
#include "graph.h"
#include "move.h"
#include "negamax.h"
#include "situation.h"

using nlohmann::json;
using namespace wallwars;

namespace {

constexpr int R = 8;
constexpr int C = 8;

struct Session {
  Situation<R, C> sit;
  int ply = 0;  // source of truth for whose turn it is; sit.turn == ply % 2.
};

int ThinkMillis(int argc, char** argv) {
  int millis = 3000;  // production default (~3s)
  if (const char* e = std::getenv("MINIMAX_THINK_MILLIS")) millis = std::atoi(e);
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--think-millis" && i + 1 < argc) millis = std::atoi(argv[++i]);
  }
  return millis < 1 ? 1 : millis;
}

json ErrorResp(const std::string& type, const std::string& bgsId,
               const std::string& err) {
  return json{{"type", type}, {"bgsId", bgsId}, {"success", false}, {"error", err}};
}

// Build the initial Situation from a classic 8x8 start config. Throws on
// anything unsupported (variant/size, goals not at the classic corners).
Situation<R, C> BuildStart(const json& config) {
  const std::string variant = config.value("variant", "");
  const int bw = config.value("boardWidth", 0);
  const int bh = config.value("boardHeight", 0);
  if (variant != "classic")
    throw std::runtime_error("unsupported variant (classic only): '" + variant + "'");
  if (bw != C || bh != R)
    throw std::runtime_error("unsupported board size (8x8 only)");

  const json& st = config.at("initialState");
  const json& pawns = st.at("pawns");
  auto cell_node = [](const json& a) {
    return NodeAt(C, a.at(0).get<int>(), a.at(1).get<int>());
  };

  Situation<R, C> sit;
  sit.SetStartingSituation();  // full graph (no walls) + standard tokens
  sit.tokens[0] = static_cast<int8_t>(cell_node(pawns.at("p1").at("cat")));
  sit.tokens[1] = static_cast<int8_t>(cell_node(pawns.at("p2").at("cat")));
  sit.turn = 0;  // P1 (engine player 0) moves first.

  // The engine's Goals are fixed by the template (classic corners). Reject any
  // start whose homes disagree, so we never silently play toward wrong goals.
  if (cell_node(pawns.at("p1").at("home")) != Goals(R, C)[0] ||
      cell_node(pawns.at("p2").at("home")) != Goals(R, C)[1])
    throw std::runtime_error("unsupported start: goals not at classic corners");

  // Apply any pre-existing walls (a fresh classic game has none).
  if (st.contains("walls")) {
    for (const auto& w : st.at("walls")) {
      const bool vertical = w.at("orientation").get<std::string>() == "vertical";
      const int e = bgs::WallToEdge(w.at("cell").at(0).get<int>(),
                                    w.at("cell").at(1).get<int>(), vertical, R, C);
      sit.G.DeactivateEdge(e);
    }
  }
  return sit;
}

const std::string& ResponseTypeFor(const std::string& req_type) {
  static const std::map<std::string, std::string> m = {
      {"start_game_session", "game_session_started"},
      {"evaluate_position", "evaluate_response"},
      {"apply_move", "move_applied"},
      {"end_game_session", "game_session_ended"}};
  static const std::string kError = "error";
  auto it = m.find(req_type);
  return it == m.end() ? kError : it->second;
}

}  // namespace

int main(int argc, char** argv) {
  const int think_millis = ThinkMillis(argc, argv);
  std::cerr << "[minimax-engine] classic 8x8, think_millis=" << think_millis << "\n";

  std::map<std::string, Session> sessions;
  Negamax<R, C> engine;  // persistent transposition table acts as a search cache.

  std::string line;
  while (std::getline(std::cin, line)) {
    if (line.empty()) continue;

    json req;
    try {
      req = json::parse(line);
    } catch (const std::exception& e) {
      std::cout << json{{"type", "error"}, {"error", std::string("parse: ") + e.what()}}.dump()
                << "\n";
      std::cout.flush();
      continue;
    }

    const std::string type = req.value("type", "");
    const std::string bgsId = req.value("bgsId", "");
    json resp;

    try {
      if (type == "start_game_session") {
        if (sessions.count(bgsId)) throw std::runtime_error("duplicate bgsId");
        Session s;
        s.sit = BuildStart(req.at("config"));
        s.ply = 0;
        sessions.emplace(bgsId, std::move(s));
        resp = json{{"type", "game_session_started"}, {"bgsId", bgsId},
                    {"success", true}, {"error", ""}};

      } else if (type == "evaluate_position") {
        auto it = sessions.find(bgsId);
        if (it == sessions.end()) throw std::runtime_error("unknown bgsId");
        Session& s = it->second;
        const int expected = req.value("expectedPly", s.ply);
        if (expected != s.ply) throw std::runtime_error("ply mismatch");

        std::string best;
        double eval;
        if (s.sit.IsGameOver()) {
          eval = bgs::TerminalEvalP1(s.sit.Winner());  // throws on unexpected -> error
          best = "---";
        } else {
          const Move m = engine.GetMove(s.sit, think_millis);  // sit passed by value
          best = bgs::MoveToStdNotation(m, s.sit);
          std::cerr << "[minimax-engine] bgs=" << bgsId << " ply=" << s.ply
                    << " bestMove=" << best << "\n";
          // Defense in depth: our own emitted move must validate against the
          // current position (catches translation regressions at the source).
          bgs::ParseAndValidate(best, s.sit);
          eval = bgs::EvalToP1(engine.LastRootEval(), s.sit.turn);
        }
        resp = json{{"type", "evaluate_response"}, {"bgsId", bgsId}, {"ply", s.ply},
                    {"bestMove", best}, {"evaluation", eval}, {"success", true}, {"error", ""}};

      } else if (type == "apply_move") {
        auto it = sessions.find(bgsId);
        if (it == sessions.end()) throw std::runtime_error("unknown bgsId");
        Session& s = it->second;
        const int expected = req.value("expectedPly", s.ply);
        if (expected != s.ply) throw std::runtime_error("ply mismatch");

        // Validate legality on a clone BEFORE mutating; throws -> error response
        // with session state left intact.
        const Move m = bgs::ParseAndValidate(req.at("move").get<std::string>(), s.sit);
        s.sit.ApplyMove(m);  // flips sit.turn
        s.ply += 1;
        resp = json{{"type", "move_applied"}, {"bgsId", bgsId}, {"ply", s.ply},
                    {"success", true}, {"error", ""}};

      } else if (type == "end_game_session") {
        sessions.erase(bgsId);
        resp = json{{"type", "game_session_ended"}, {"bgsId", bgsId},
                    {"success", true}, {"error", ""}};

      } else {
        throw std::runtime_error("unknown message type: '" + type + "'");
      }
    } catch (const std::exception& e) {
      resp = ErrorResp(ResponseTypeFor(type), bgsId, e.what());
    }

    std::cout << resp.dump() << "\n";
    std::cout.flush();
  }
  return 0;
}
