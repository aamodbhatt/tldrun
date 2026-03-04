import { motion } from "motion/react"
import { FileText, Sparkles, Cat, BookOpen } from "lucide-react"

export function AnimatedBackground() {
  return (
    <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10 bg-background transition-colors duration-1000">

      {/* Aurora / Nebula Gradients */}
      <div className="absolute top-[-20%] left-[-10%] w-[70vw] h-[70vh] opacity-[0.15] mix-blend-screen">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(99,102,241,0.8)_0%,transparent_70%)] blur-[100px] rounded-full animate-aurora-slow" />
      </div>

      <div className="absolute bottom-[-20%] right-[-10%] w-[80vw] h-[80vh] opacity-[0.12] mix-blend-screen">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(34,211,238,0.8)_0%,transparent_70%)] blur-[120px] rounded-full animate-aurora-fast" />
      </div>

      <div className="absolute top-[30%] left-[40%] w-[50vw] h-[50vh] opacity-[0.08] mix-blend-screen">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(168,85,247,0.8)_0%,transparent_70%)] blur-[130px] rounded-full animate-aurora-medium" />
      </div>

      {/* Floating Giant Papers */}
      <motion.div
        className="absolute text-primary/[0.08] dark:text-primary/[0.05]"
        initial={{ y: "110vh", x: "-10vw", rotate: -15 }}
        animate={{ y: "-30vh", x: "30vw", rotate: 15 }}
        transition={{ duration: 45, repeat: Infinity, ease: "linear" }}
      >
        <FileText size={500} strokeWidth={0.5} />
      </motion.div>

      <motion.div
        className="absolute text-primary/[0.06] dark:text-primary/[0.04]"
        initial={{ y: "110vh", x: "70vw", rotate: 20 }}
        animate={{ y: "-30vh", x: "40vw", rotate: -10 }}
        transition={{ duration: 60, repeat: Infinity, ease: "linear", delay: 15 }}
      >
        <BookOpen size={400} strokeWidth={0.5} />
      </motion.div>

      {/* Cute Sparkles / Dust */}
      {Array.from({ length: 12 }).map((_, i) => (
        <motion.div
          key={i}
          className="absolute text-primary/[0.35] dark:text-primary/[0.25]"
          initial={{
            y: `${Math.random() * 100}vh`,
            x: `${Math.random() * 100}vw`,
            scale: 0.5,
            opacity: 0
          }}
          animate={{
            y: [null, `${Math.random() * 100}vh`],
            x: [null, `${Math.random() * 100}vw`],
            scale: [0.5, 1, 0.5],
            opacity: [0, 1, 0]
          }}
          transition={{
            duration: 10 + Math.random() * 15,
            repeat: Infinity,
            ease: "easeInOut",
            delay: Math.random() * 10
          }}
        >
          <Sparkles size={16} />
        </motion.div>
      ))}

      {/* A single cute cat floating slowly in space */}
      {/* A single cute cat floating slowly in space */}
      <motion.div
        className="absolute text-primary/[0.15] dark:text-primary/[0.12]"
        initial={{ y: "80vh", x: "-10vw", rotate: -10 }}
        animate={{ y: "10vh", x: "110vw", rotate: 20 }}
        transition={{ duration: 90, repeat: Infinity, ease: "linear" }}
      >
        <Cat size={64} strokeWidth={1} />
      </motion.div>

      {/* Extremely faint noise texture overlay for a premium "matte" finish */}
      <div className="absolute inset-0 opacity-[0.015]" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=%220 0 200 200%22 xmlns=%22http://www.w3.org/2000/svg%22%3E%3Cfilter id=%22noiseFilter%22%3E%3CfeTurbulence type=%22fractalNoise%22 baseFrequency=%220.85%22 numOctaves=%223%22 stitchTiles=%22stitch%22/%3E%3C/filter%3E%3Crect width=%22100%25%22 height=%22100%25%22 filter=%22url(%23noiseFilter)%22/%3E%3C/svg%3E")' }} />
    </div>
  )
}
