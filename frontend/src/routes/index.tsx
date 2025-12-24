import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GameShowcase } from "@/components/game-showcase";
import { Sparkles, Brain, Bot, BookOpen, Users, UserPlus } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 md:py-12">
        <div className="grid xl:grid-cols-2 gap-12 xl:gap-16 items-start">
          {/* Left Column */}
          <div className="space-y-20">
            {/* Single-player Fun */}
            <section>
              <div className="text-center mb-12">
                <h2 className="font-serif text-4xl md:text-5xl font-bold text-foreground">
                  Single-player Fun
                </h2>
              </div>

              <div className="grid grid-cols-2 gap-6 max-w-2xl mx-auto">
                <Link to="/solo-campaign" className="group">
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-3 text-card-foreground">
                        <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <Sparkles className="h-5 w-5 text-primary" />
                        </div>
                        <span className="flex items-center gap-2">
                          Solo Campaign
                          <span className="inline-flex items-center rounded-full bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
                            Start here!
                          </span>
                        </span>
                      </CardTitle>
                      <CardDescription>
                        Begin your journey with carefully crafted challenges
                        that teach you the fundamentals
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>

                <Link to="/puzzles" className="group">
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-3 text-card-foreground">
                        <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <Brain className="h-5 w-5 text-primary" />
                        </div>
                        Puzzles
                      </CardTitle>
                      <CardDescription>
                        Test your tactical prowess with mind-bending positional
                        challenges
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>

                <Link
                  to="/game-setup"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      sessionStorage.setItem("game-setup-mode", "vs-ai");
                    }
                  }}
                  className="group"
                >
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-3 text-card-foreground">
                        <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <Bot className="h-5 w-5 text-primary" />
                        </div>
                        Play vs AI
                      </CardTitle>
                      <CardDescription>
                        Challenge our AI opponents from Easy to Hard difficulty
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>

                <Link to="/study-board" className="group">
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-3 text-card-foreground">
                        <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <BookOpen className="h-5 w-5 text-primary" />
                        </div>
                        Study Board
                      </CardTitle>
                      <CardDescription>
                        Analyze positions and experiment with strategies freely
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              </div>
            </section>

            {/* Play with Others */}
            <section>
              <div className="text-center mb-12">
                <h2 className="font-serif text-4xl md:text-5xl font-bold text-foreground">
                  Play with Others
                </h2>
              </div>

              <div className="grid grid-cols-2 gap-6 max-w-2xl mx-auto">
                <Link
                  to="/game-setup"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      sessionStorage.setItem("game-setup-mode", "with-others");
                    }
                  }}
                  className="group"
                >
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-3 text-card-foreground">
                        <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <Users className="h-5 w-5 text-primary" />
                        </div>
                        Find Others
                      </CardTitle>
                      <CardDescription>
                        Get matched with players of similar skill level for
                        competitive rated games
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>

                <Link
                  to="/game-setup"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      sessionStorage.setItem(
                        "game-setup-mode",
                        "invite-friend",
                      );
                    }
                  }}
                  className="group"
                >
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-3 text-card-foreground">
                        <div className="w-10 h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <UserPlus className="h-5 w-5 text-primary" />
                        </div>
                        Invite Friend
                      </CardTitle>
                      <CardDescription>
                        Share a link and play casual or competitive games with
                        friends
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              </div>
            </section>
          </div>

          {/* Right Column */}
          <div>
            {/* Game Showcase */}
            <section>
              <div className="text-center mb-12">
                <h2 className="font-serif text-4xl md:text-5xl font-bold text-foreground">
                  Watch & Learn
                </h2>
              </div>

              <div className="max-w-2xl mx-auto xl:max-w-none">
                <Link to="/learn" className="group block">
                  <GameShowcase />
                </Link>
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-border mt-20">
        <div className="container mx-auto px-4 py-12">
          <div className="text-center text-sm text-muted-foreground">
            <p className="mb-2">
              Wall Game is inspired by Quoridor and Blockade
            </p>
            <p>Built with strategy, played with elegance</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
