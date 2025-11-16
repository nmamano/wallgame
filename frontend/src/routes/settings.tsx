import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { useTheme } from "@/components/theme-provider";
import { Moon, Sun, Bell, Volume2, Eye } from "lucide-react";

export const Route = createFileRoute("/settings")({
  component: Settings,
});

function Settings() {
  const { theme, setTheme } = useTheme();
  const [notifications, setNotifications] = useState(true);
  const [sounds, setSounds] = useState(true);
  const [animations, setAnimations] = useState(true);

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-12">
        <div className="max-w-3xl mx-auto space-y-8">
          {/* Header */}
          <div className="space-y-2">
            <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground">
              Settings
            </h1>
            <p className="text-lg text-muted-foreground">
              Customize your Wall Game experience
            </p>
          </div>

          {/* Appearance */}
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-2xl">Appearance</CardTitle>
              <CardDescription>
                Customize how Wall Game looks on your device
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label
                    htmlFor="theme"
                    className="text-base font-medium flex items-center gap-2"
                  >
                    {theme === "dark" ? (
                      <Moon className="h-4 w-4 text-primary" />
                    ) : (
                      <Sun className="h-4 w-4 text-accent" />
                    )}
                    Dark Mode
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {theme === "dark"
                      ? "Experience the baroque aesthetic with rich blues and warm accents"
                      : "Enjoy warm golds and oranges in light mode"}
                  </p>
                </div>
                <Switch
                  id="theme"
                  checked={theme === "dark"}
                  onCheckedChange={(checked) =>
                    setTheme(checked ? "dark" : "light")
                  }
                />
              </div>
            </CardContent>
          </Card>

          {/* Notifications */}
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-2xl">Notifications</CardTitle>
              <CardDescription>
                Manage how you receive updates and alerts
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label
                    htmlFor="notifications"
                    className="text-base font-medium flex items-center gap-2"
                  >
                    <Bell className="h-4 w-4" />
                    Game Notifications
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Receive notifications when it's your turn or when games
                    finish
                  </p>
                </div>
                <Switch
                  id="notifications"
                  checked={notifications}
                  onCheckedChange={setNotifications}
                />
              </div>
            </CardContent>
          </Card>

          {/* Game Settings */}
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-2xl">Game Experience</CardTitle>
              <CardDescription>
                Customize your gameplay preferences
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label
                    htmlFor="sounds"
                    className="text-base font-medium flex items-center gap-2"
                  >
                    <Volume2 className="h-4 w-4" />
                    Sound Effects
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Play sounds for moves, captures, and game events
                  </p>
                </div>
                <Switch
                  id="sounds"
                  checked={sounds}
                  onCheckedChange={setSounds}
                />
              </div>

              <Separator />

              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label
                    htmlFor="animations"
                    className="text-base font-medium flex items-center gap-2"
                  >
                    <Eye className="h-4 w-4" />
                    Animations
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Enable smooth transitions and piece animations
                  </p>
                </div>
                <Switch
                  id="animations"
                  checked={animations}
                  onCheckedChange={setAnimations}
                />
              </div>
            </CardContent>
          </Card>

          {/* Account Actions */}
          <Card className="border-border/50 bg-card/50 backdrop-blur">
            <CardHeader>
              <CardTitle className="text-2xl">Account</CardTitle>
              <CardDescription>Manage your Wall Game account</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button variant="outline" className="w-full justify-start">
                Change Password
              </Button>
              <Button variant="outline" className="w-full justify-start">
                Export Game Data
              </Button>
              <Separator />
              <Button variant="destructive" className="w-full justify-start">
                Delete Account
              </Button>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
