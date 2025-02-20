import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { userQueryOptions } from "@/lib/api";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/profile")({
  component: Profile,
});

function Profile() {
  const { isPending, error, data } = useQuery(userQueryOptions);
  if (isPending) {
    return <div>Loading...</div>;
  }
  if (error) {
    return <div>Error: {error.message}</div>;
  }
  return (
    <div>
      <div>Hello {data.user.email}!</div>
      <Button asChild className="my-4">
        <a href="/api/logout">Logout!</a>
      </Button>
    </div>
  );
}
