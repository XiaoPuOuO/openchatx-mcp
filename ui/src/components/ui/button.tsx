import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"
import type { ButtonHTMLAttributes } from "react"

import { cn } from "../../lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[7px] text-[13px] font-medium transition-all disabled:pointer-events-none disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(0_122_255/0.35)] active:scale-[0.985]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-[0_1px_1px_rgba(0,0,0,0.06)] hover:brightness-[0.98]",
        outline: "border bg-white/80 shadow-[0_1px_1px_rgba(0,0,0,0.03)] hover:bg-white",
        ghost: "hover:bg-[rgb(118_118_128/0.08)]",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
)

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button"
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
