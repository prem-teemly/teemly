import { Suspense } from "react";
import DepartmentPage from "../../components/DepartmentPage";

// Departments come from the backend (built-in and added in Settings), so each page is rendered on
// request; the component shows "Department not found." for an unknown one.
async function Department({ params }: { params: Promise<{ dept: string }> }) {
  const { dept } = await params;
  return <DepartmentPage slug={dept} />;
}

export default function Page({ params }: { params: Promise<{ dept: string }> }) {
  return (
    <Suspense fallback={null}>
      <Department params={params} />
    </Suspense>
  );
}
