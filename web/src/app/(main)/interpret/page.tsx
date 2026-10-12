import { Suspense } from "react";
import { InterpretView } from "@/components/interpret/interpret-view";

export const metadata = { title: "同声传译 · 译桥 · LinguaBridge" };

export default function InterpretPage() {
  return (
    <Suspense>
      <InterpretView />
    </Suspense>
  );
}
