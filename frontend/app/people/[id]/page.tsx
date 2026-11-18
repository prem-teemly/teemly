import { Suspense } from "react";
import PersonAccount from "../../components/PersonAccount";

// People come from the backend (GET /api/people/:id), so each page is rendered on request; the
// component shows "Person not found." for an unknown id.
async function Person({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PersonAccount id={id} />;
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={null}>
      <Person params={params} />
    </Suspense>
  );
}
