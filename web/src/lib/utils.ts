import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn's class merger: conditional classes (clsx) + Tailwind conflict resolution (twMerge). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
