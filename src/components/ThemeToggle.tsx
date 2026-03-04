import React from 'react';
import { Moon, Sun, Flower2 } from "lucide-react"
import { useTheme, Theme } from "./ThemeProvider"
import { motion } from "motion/react"
import { cn } from "../lib/utils"

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme()

  const themes: { id: Theme; icon: React.ElementType; label: string; color: string }[] = [
    { id: 'light', icon: Sun, label: 'Light', color: 'text-orange-500' },
    { id: 'dark', icon: Moon, label: 'Dark', color: 'text-indigo-400' },
    { id: 'pink', icon: Flower2, label: 'Pink', color: 'text-pink-500' },
  ]

  return (
    <div className={cn("flex items-center p-1.5 bg-muted/50 border border-border/50 rounded-full relative backdrop-blur-md shadow-inner gap-1", className)}>
      {themes.map((t) => {
        const Icon = t.icon
        const isActive = theme === t.id
        return (
          <button
            key={t.id}
            onClick={() => setTheme(t.id)}
            className={cn(
              "relative flex items-center justify-center w-10 h-10 rounded-full z-10 transition-colors duration-300",
              isActive ? "text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            )}
            aria-label={`Switch to ${t.label} theme`}
          >
            {isActive && (
              <motion.div
                layoutId="theme-toggle-indicator"
                className="absolute inset-0 bg-primary/90 rounded-full shadow-md backdrop-blur-sm border border-primary/20"
                transition={{ type: "spring", stiffness: 450, damping: 25 }}
              />
            )}
            <motion.div
              initial={false}
              animate={isActive ? {
                rotate: t.id === 'light' ? 90 : t.id === 'dark' ? -25 : 45,
                scale: 1.15,
              } : {
                rotate: 0,
                scale: 0.95
              }}
              transition={{ type: "spring", stiffness: 450, damping: 15 }}
              className={cn("relative z-20 transition-colors duration-300", isActive ? "text-white drop-shadow-sm" : t.color)}
            >
              <Icon size={18} strokeWidth={2.5} />
            </motion.div>
          </button>
        )
      })}
    </div>
  )
}
