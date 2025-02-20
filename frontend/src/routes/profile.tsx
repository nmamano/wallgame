import { createFileRoute } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

export const Route = createFileRoute("/profile")({
  component: Profile,
});

async function getCurrentUser() {
  const res = await api.me.$get();
  if (!res.ok) {
    throw new Error(
      `Server error: Failed to fetch current user: ${res.statusText}`
    );
  }
  const data = await res.json();
  return data;
}

function Profile() {
  const { isPending, error, data } = useQuery({
    queryKey: ["get-current-user"],
    queryFn: getCurrentUser,
  });
  if (isPending) {
    return <div>Loading...</div>;
  }
  if (error) {
    return <div>Error: {error.message}</div>;
  }
  return <div>Hello {data.user.email}!</div>;
}
