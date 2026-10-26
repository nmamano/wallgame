import { Card } from "@/components/ui/card";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";

/**
 * A page of prose: a title, a subtitle and a markdown body in a card. Shared
 * by About, Privacy and Terms. A link that leaves the site opens in a new tab.
 */
export function MarkdownPage({
  title,
  subtitle,
  markdown,
}: {
  title: string;
  subtitle: string;
  markdown: string;
}) {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto py-12 px-4">
        <div className="max-w-3xl mx-auto">
          <div className="space-y-2 mb-8">
            <h1 className="text-4xl font-serif font-bold tracking-tight text-foreground text-balance">
              {title}
            </h1>
            <p className="text-lg text-muted-foreground">{subtitle}</p>
          </div>

          <Card className="p-8 border-border/50 bg-card/50 backdrop-blur">
            <div className="space-y-4 text-foreground leading-relaxed prose dark:prose-invert max-w-none prose-headings:font-serif prose-headings:font-bold prose-a:text-primary prose-a:transition-colors prose-a:hover:text-primary/80">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={{
                  a: ({
                    href,
                    ...props
                  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
                    href?: string;
                  }) => {
                    if (href?.startsWith("http")) {
                      return (
                        <a
                          {...props}
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                        />
                      );
                    }
                    return <a {...props} href={href} />;
                  },
                }}
              >
                {markdown}
              </ReactMarkdown>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
