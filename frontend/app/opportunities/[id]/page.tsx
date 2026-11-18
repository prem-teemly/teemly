import { Suspense } from "react";
import OpportunityDetail from "../../components/OpportunityDetail";

// One opportunity (opened from the opportunity panel), rendered on request.
async function Opportunity({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OpportunityDetail id={id} />;
}

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={null}>
      <Opportunity params={params} />
    </Suspense>
  );
}
