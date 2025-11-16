import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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
      {/* Hero Section */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 engraving-texture" />
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5" />

        <div className="container relative mx-auto px-4 py-20 md:py-32">
          <div className="max-w-4xl mx-auto text-center space-y-8">
            <div className="inline-block">
              <div className="inline-flex items-center rounded-full border border-border bg-muted px-4 py-1.5 text-sm text-foreground mb-6">
                <Sparkles className="h-4 w-4 mr-2" />
                Strategic Board Game
              </div>
            </div>

            <h1 className="font-serif text-5xl md:text-7xl font-bold tracking-tight text-balance text-foreground">
              Master the Art of{" "}
              <span className="bg-gradient-to-r from-accent to-primary bg-clip-text text-transparent">
                Strategic Walls
              </span>
            </h1>

            <p className="text-xl md:text-2xl text-muted-foreground max-w-2xl mx-auto text-balance leading-relaxed">
              Outsmart your opponents, build impenetrable barriers, and claim
              victory in this elegant game of tactics and foresight.
            </p>
          </div>
        </div>
      </section>

      <div className="container mx-auto px-4 py-16 md:py-24 space-y-20">
        {/* Single-player Fun */}
        <section>
          <div className="text-center mb-12">
            <h2 className="font-serif text-4xl md:text-5xl font-bold mb-4 text-foreground">
              Single-player Fun
            </h2>
            <p className="text-lg text-muted-foreground">
              Master the game at your own pace
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            <Link to="/solo-campaign" className="group">
              <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-2 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                <CardHeader>
                  <div className="w-12 h-12 rounded-lg bg-accent/20 flex items-center justify-center mb-4 group-hover:bg-accent/30 transition-colors">
                    <Sparkles className="h-6 w-6 text-accent" />
                  </div>
                  <CardTitle className="flex items-center gap-2 text-card-foreground">
                    Solo Campaign
                    <span className="inline-flex items-center rounded-full bg-primary/20 px-2 py-0.5 text-xs font-medium text-primary">
                      Start here!
                    </span>
                  </CardTitle>
                  <CardDescription>
                    Begin your journey with carefully crafted challenges that
                    teach you the fundamentals
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>

            <Link to="/puzzles" className="group">
              <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-2 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                <CardHeader>
                  <div className="w-12 h-12 rounded-lg bg-primary/20 flex items-center justify-center mb-4 group-hover:bg-primary/30 transition-colors">
                    <Brain className="h-6 w-6 text-primary" />
                  </div>
                  <CardTitle className="text-card-foreground">
                    Puzzles
                  </CardTitle>
                  <CardDescription>
                    Test your tactical prowess with mind-bending positional
                    challenges
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>

            <Link to="/play-vs-ai" className="group">
              <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-2 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                <CardHeader>
                  <div className="w-12 h-12 rounded-lg bg-accent/20 flex items-center justify-center mb-4 group-hover:bg-accent/30 transition-colors">
                    <Bot className="h-6 w-6 text-accent" />
                  </div>
                  <CardTitle className="text-card-foreground">
                    Play vs AI
                  </CardTitle>
                  <CardDescription>
                    Challenge our AI opponents from Easy to Hard difficulty
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>

            <Link to="/study-board" className="group">
              <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-2 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                <CardHeader>
                  <div className="w-12 h-12 rounded-lg bg-primary/20 flex items-center justify-center mb-4 group-hover:bg-primary/30 transition-colors">
                    <BookOpen className="h-6 w-6 text-primary" />
                  </div>
                  <CardTitle className="text-card-foreground">
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
            <h2 className="font-serif text-4xl md:text-5xl font-bold mb-4 text-foreground">
              Play with Others
            </h2>
            <p className="text-lg text-muted-foreground">
              Test your skills against real opponents
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6 max-w-3xl mx-auto">
            <Link to="/find-others" className="group">
              <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-2 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                <CardHeader>
                  <div className="w-12 h-12 rounded-lg bg-accent/20 flex items-center justify-center mb-4 group-hover:bg-accent/30 transition-colors">
                    <Users className="h-6 w-6 text-accent" />
                  </div>
                  <CardTitle className="text-card-foreground">
                    Find Others
                  </CardTitle>
                  <CardDescription>
                    Get matched with players of similar skill level for
                    competitive rated games
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button className="w-full" size="lg">
                    Quick Match
                  </Button>
                </CardContent>
              </Card>
            </Link>

            <Link to="/invite-friend" className="group">
              <Card className="h-full border-2 border-border bg-card transition-all duration-300 hover:border-primary hover:shadow-lg hover:-translate-y-2 hover:shadow-[0_0_30px_rgba(217,153,74,0.3)] dark:hover:shadow-[0_0_30px_rgba(217,153,74,0.2)]">
                <CardHeader>
                  <div className="w-12 h-12 rounded-lg bg-primary/20 flex items-center justify-center mb-4 group-hover:bg-primary/30 transition-colors">
                    <UserPlus className="h-6 w-6 text-primary" />
                  </div>
                  <CardTitle className="text-card-foreground">
                    Invite Friend
                  </CardTitle>
                  <CardDescription>
                    Share a link and play casual or competitive games with
                    friends
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button className="w-full" variant="outline" size="lg">
                    Create Invite
                  </Button>
                </CardContent>
              </Card>
            </Link>
          </div>
        </section>

        {/* Game Showcase */}
        <section>
          <div className="text-center mb-12">
            <h2 className="font-serif text-4xl md:text-5xl font-bold mb-4 text-foreground">
              Watch & Learn
            </h2>
            <p className="text-lg text-muted-foreground">
              Study games from top players
            </p>
          </div>

          <div className="max-w-2xl mx-auto">
            <GameShowcase />
          </div>
        </section>
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
