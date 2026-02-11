import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { GameShowcase } from "@/components/game-showcase";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Sparkles, Brain, Bot, BookOpen, Users, UserPlus } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const isSmallScreen = useMediaQuery("(max-width: 639px)");
  const showcaseContainerClass = isSmallScreen
    ? ""
    : "max-w-2xl mx-auto xl:max-w-none";

  return (
    <div className="bg-background">
      <div className="container mx-auto px-4 py-4 md:py-8 lg:py-12">
        <div className="grid xl:grid-cols-2 gap-6 lg:gap-12 xl:gap-16 items-start">
          {/* Left Column */}
          <div className="space-y-6 lg:space-y-20">
            {/* Single-player Fun */}
            <section>
              <div className="text-center mb-3 lg:mb-12">
                <h2 className="font-serif text-2xl sm:text-4xl md:text-5xl font-bold text-foreground">
                  Single-player Fun
                </h2>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:gap-6 max-w-2xl mx-auto">
                <Link to="/solo-campaign" className="group min-w-0">
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)] py-2 sm:py-6">
                    <CardHeader className="flex items-center sm:flex-col sm:items-start sm:gap-1.5 px-3 py-1 sm:p-6">
                      <CardTitle className="flex items-center gap-2 sm:gap-3 font-serif text-base sm:text-xl text-card-foreground">
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <Sparkles className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                        </div>
                        Campaign
                      </CardTitle>
                      <CardDescription className="hidden sm:block">
                        Start here! Begin your journey with carefully crafted
                        challenges that teach you the fundamentals.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>

                <Link to="/puzzles" className="group min-w-0">
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)] py-2 sm:py-6">
                    <CardHeader className="flex items-center sm:flex-col sm:items-start sm:gap-1.5 px-3 py-1 sm:p-6">
                      <CardTitle className="flex items-center gap-2 sm:gap-3 font-serif text-base sm:text-xl text-card-foreground">
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <Brain className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                        </div>
                        Puzzles
                      </CardTitle>
                      <CardDescription className="hidden sm:block">
                        Test your tactical prowess with mind-bending positional
                        challenges.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>

                <Link
                  to="/play"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      sessionStorage.setItem("play-mode", "vs-ai");
                    }
                  }}
                  className="group min-w-0"
                >
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)] py-2 sm:py-6">
                    <CardHeader className="flex items-center sm:flex-col sm:items-start sm:gap-1.5 px-3 py-1 sm:p-6">
                      <CardTitle className="flex items-center gap-2 sm:gap-3 font-serif text-base sm:text-xl text-card-foreground">
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <Bot className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                        </div>
                        Play vs AI
                      </CardTitle>
                      <CardDescription className="hidden sm:block">
                        Challenge our AI opponent from easy to hard difficulty.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>

                <Link to="/study-board" className="group min-w-0">
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)] py-2 sm:py-6">
                    <CardHeader className="flex items-center sm:flex-col sm:items-start sm:gap-1.5 px-3 py-1 sm:p-6">
                      <CardTitle className="flex items-center gap-2 sm:gap-3 font-serif text-base sm:text-xl text-card-foreground">
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <BookOpen className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                        </div>
                        Study Board
                      </CardTitle>
                      <CardDescription className="hidden sm:block">
                        Analyze positions and experiment with strategies freely.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>
              </div>
            </section>

            {/* Play with Others */}
            <section>
              <div className="text-center mb-3 lg:mb-12">
                <h2 className="font-serif text-2xl sm:text-4xl md:text-5xl font-bold text-foreground">
                  Play with Others
                </h2>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:gap-6 max-w-2xl mx-auto">
                <Link
                  to="/play"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      sessionStorage.setItem("play-mode", "with-others");
                    }
                  }}
                  className="group min-w-0"
                >
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)] py-2 sm:py-6">
                    <CardHeader className="flex items-center sm:flex-col sm:items-start sm:gap-1.5 px-3 py-1 sm:p-6">
                      <CardTitle className="flex items-center gap-2 sm:gap-3 font-serif text-base sm:text-xl text-card-foreground">
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <Users className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                        </div>
                        Find Others
                      </CardTitle>
                      <CardDescription className="hidden sm:block">
                        Get matched with players of similar skill level for
                        competitive rated games.
                      </CardDescription>
                    </CardHeader>
                  </Card>
                </Link>

                <Link
                  to="/play"
                  onClick={() => {
                    if (typeof window !== "undefined") {
                      sessionStorage.setItem("play-mode", "invite-friend");
                    }
                  }}
                  className="group min-w-0"
                >
                  <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-1 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)] py-2 sm:py-6">
                    <CardHeader className="flex items-center sm:flex-col sm:items-start sm:gap-1.5 px-3 py-1 sm:p-6">
                      <CardTitle className="flex items-center gap-2 sm:gap-3 font-serif text-base sm:text-xl text-card-foreground">
                        <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-lg bg-primary/20 flex items-center justify-center group-hover:bg-primary/30 transition-colors flex-shrink-0">
                          <UserPlus className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                        </div>
                        Invite Friend
                      </CardTitle>
                      <CardDescription className="hidden sm:block">
                        Share a link and play casual or competitive games with
                        friends.
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
              <div className="text-center mb-3 lg:mb-12">
                <h2 className="font-serif text-2xl sm:text-4xl md:text-5xl font-bold text-foreground">
                  Watch & Learn
                </h2>
              </div>

              <div className={showcaseContainerClass}>
                <GameShowcase flush={isSmallScreen} />
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-border mt-6 lg:mt-20">
        <div className="container mx-auto px-4 py-3 lg:py-12">
          <div className="text-center text-xs lg:text-sm text-muted-foreground">
            <p>
              Created by{" "}
              <a
                href="https://nilmamano.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-primary transition-colors"
              >
                Nil Mamano.
              </a>
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
