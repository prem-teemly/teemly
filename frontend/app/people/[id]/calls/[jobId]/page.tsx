import { Suspense } from "react";
import PersonCall from "../../../../components/PersonCall";

// One call or chat of a person (opened from their timeline), rendered on request.
async function Call({ params }: { params: Promise<{ id: string; jobId: string }> }) {
  const { id, jobId } = await params;
  return <PersonCall personId={id} jobId={jobId} />;
}

export default function Page({ params }: { params: Promise<{ id: string; jobId: string }> }) {
  return (
    <Suspense fallback={null}>
      <Call params={params} />
    </Suspense>
  );
}
