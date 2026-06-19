import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto max-w-5xl px-5 py-10">
      <Skeleton className="h-8 w-52" />
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="mt-8 h-40 rounded-2xl" />
      <Skeleton className="mt-8 h-64 rounded-2xl" />
    </main>
  );
}
