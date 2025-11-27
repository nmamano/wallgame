import { Link, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { Menu, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useTheme } from "./theme-provider";
import { useQuery } from "@tanstack/react-query";
import { userQueryOptions } from "@/lib/api";

export function Navigation() {
  const [isOpen, setIsOpen] = useState(false);
  const router = useRouterState();
  const pathname = router.location.pathname;
  const { theme, setTheme } = useTheme();
  const { data } = useQuery(userQueryOptions);
  const isLoggedIn = !!data?.user;

  const navItems = [
    { label: "Play", href: "/" },
    { label: "Ranking", href: "/ranking" },
    { label: "Past Games", href: "/past-games" },
    { label: "Live Games", href: "/live-games" },
    { label: "Learn", href: "/learn" },
    { label: "About", href: "/about" },
    { label: "Settings", href: "/settings" },
    { label: isLoggedIn ? "Profile" : "Login", href: "/profile" },
  ];

  return (
    <nav className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto px-4">
        <div className="flex h-10 lg:h-16 items-center justify-between">
          <Link to="/" className="flex items-center space-x-2">
            <img
              src="/logo.png"
              alt="WallGame Logo"
              className="h-6 lg:h-8 w-auto object-contain mix-blend-multiply dark:mix-blend-screen"
            />
            <div className="text-xl lg:text-2xl font-serif font-bold tracking-tight text-foreground">
              Wall<span className="text-primary">Game</span>
            </div>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden lg:flex items-center space-x-1">
            {navItems.map((item) => (
              <Link key={item.href} to={item.href}>
                <Button
                  variant={pathname === item.href ? "secondary" : "ghost"}
                  className="text-sm font-medium"
                >
                  {item.label}
                </Button>
              </Link>
            ))}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? (
                <Sun className="h-5 w-5" />
              ) : (
                <Moon className="h-5 w-5" />
              )}
            </Button>
          </div>

          {/* Mobile Navigation */}
          <div className="flex lg:hidden items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            >
              {theme === "dark" ? (
                <Sun className="h-5 w-5" />
              ) : (
                <Moon className="h-5 w-5" />
              )}
            </Button>
            <Sheet open={isOpen} onOpenChange={setIsOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon">
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-64">
                <nav className="flex flex-col space-y-2 mt-8">
                  {navItems.map((item) => (
                    <Link key={item.href} to={item.href}>
                      <Button
                        variant={pathname === item.href ? "secondary" : "ghost"}
                        className="w-full justify-start text-base"
                        onClick={() => setIsOpen(false)}
                      >
                        {item.label}
                      </Button>
                    </Link>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </div>
    </nav>
  );
}
