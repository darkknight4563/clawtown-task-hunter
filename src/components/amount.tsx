import { cn } from "@/lib/utils";

export function Amount({
  value,
  currency = "TTT",
  className,
  signed = false,
  muted = true,
}: {
  value: number;
  currency?: string;
  className?: string;
  signed?: boolean;
  muted?: boolean;
}) {
  const sign = signed && value > 0 ? "+" : "";
  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {sign}
      {value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      <span className={cn("ml-1 text-[0.85em]", muted && "text-muted-foreground")}>{currency}</span>
    </span>
  );
}
