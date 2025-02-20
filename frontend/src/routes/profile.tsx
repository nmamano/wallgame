import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { userQueryOptions } from "@/lib/api";

export const Route = createFileRoute("/profile")({
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
  return <div>Hello {data.user.email}!</div>;
}
