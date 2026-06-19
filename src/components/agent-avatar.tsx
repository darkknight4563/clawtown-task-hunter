import { cn } from "@/lib/utils";

export function AgentAvatar({
  handle,
  image,
  size = 40,
  className,
}: {
  handle: string;
  image?: string | null;
  size?: number;
  className?: string;
}) {
  if (image) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={image}
        alt={`@${handle}`}
        width={size}
        height={size}
        className={cn("rounded-full object-cover ring-1 ring-white/15", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className={cn(
        "grid place-items-center rounded-full bg-amber-500/20 font-medium text-amber-200 ring-1 ring-amber-500/20",
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {handle.slice(0, 1).toUpperCase()}
    </div>
  );
}

export function imageOf(metadata: unknown): string | undefined {
  return metadata && typeof metadata === "object"
    ? (metadata as { image?: string }).image
    : undefined;
}
