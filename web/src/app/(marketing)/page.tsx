import type { Metadata } from "next";
import { BotIcon, ShieldCheckIcon, SparklesIcon } from "lucide-react";
import { Bento } from "@/components/landing/bento";
import { CompareSection } from "@/components/landing/compare";
import { DocJourney } from "@/components/landing/doc-journey";
import { HeroTrace, SeeHowButton } from "@/components/landing/hero-demo";
import { LumiShowcase } from "@/components/landing/lumi-showcase";
import { AuthCta } from "@/components/landing/marketing-header";
import { Playground } from "@/components/landing/playground";
import { Reveal, SectionHeading } from "@/components/landing/reveal";
import { Faq, Stats } from "@/components/landing/stats-faq";

export const metadata: Metadata = {
  title: "译桥 · LinguaBridge · 会思考、会追问、会自查的翻译 Agent",
  description: "译桥 · LinguaBridge：过程可见的翻译 Agent、术语库与翻译记忆、长文档篇章翻译、同声传译与 AI 数字人对话。",
};

function Section({ id, children, className }: { id?: string; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={`scroll-mt-20 px-4 py-16 md:px-6 md:py-24 ${className ?? ""}`}>
      <div className="mx-auto max-w-6xl">{children}</div>
    </section>
  );
}

/**
 * 访客首页（add-ai-avatar-and-landing / landing-page）：
 * Hero → 交互试玩 → 与传统方式对比 → 和 AI 面对面 → 能力 bento → 长文档旅程 → 评测数据 → 收尾 CTA 与 FAQ。
 * 所有演示均为前端回放；Hero 标题由服务端直接渲染，不从透明开始动画（LCP）。
 */
export default function LandingPage() {
  return (
    <>
      {/* 1. Hero */}
      <section className="relative overflow-hidden px-4 pt-10 pb-16 md:px-6 md:pt-16 md:pb-24">
        <div aria-hidden className="absolute inset-0 -z-10 bg-auth-glow opacity-80" />
        <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
          <div>
            <div className="mb-5 inline-flex items-center gap-1.5 rounded-full border bg-card/80 px-3 py-1 text-xs font-medium shadow-card backdrop-blur">
              <SparklesIcon className="size-3.5 text-brand" />
              分析 → 规划 → 翻译 → 评审 → 修正，每一步都看得见
            </div>
            <h1 className="text-4xl leading-[1.12] font-semibold tracking-tight text-balance md:text-5xl">
              会思考、会追问、
              <br />
              <span className="bg-brand-gradient bg-clip-text text-transparent">会自查</span>的翻译 Agent
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted-foreground text-pretty md:text-lg">
              不只是把句子换成另一种语言：它会先读懂上下文、遵守你的术语库，遇到歧义主动问你，译完再自己检查一遍。文档、图片、同声传译，还有能陪你开口说外语的数字人 Lumi。
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <AuthCta size="lg" />
              <SeeHowButton />
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <li className="inline-flex items-center gap-1.5">
                <ShieldCheckIcon className="size-3.5 text-success" />
                术语库硬约束
              </li>
              <li className="inline-flex items-center gap-1.5">
                <ShieldCheckIcon className="size-3.5 text-success" />
                篇章与会话上下文
              </li>
              <li className="inline-flex items-center gap-1.5">
                <BotIcon className="size-3.5 text-brand" />
                AI 数字人实时对话
              </li>
            </ul>
          </div>
          <HeroTrace />
        </div>
      </section>

      {/* 2. 交互试玩 */}
      <Section id="demo" className="bg-surface/60">
        <Reveal>
          <SectionHeading
            eyebrow="交互试玩"
            title="亲手试试：它在哪些地方比“直接翻”更聪明"
            desc="选一个样例，看 Agent 怎样分析、规划、翻译和评审。遇到歧义时，它会停下来问你。"
          />
        </Reveal>
        <Reveal className="mt-10">
          <Playground />
        </Reveal>
      </Section>

      {/* 3. 与传统方式对比 */}
      <Section id="compare">
        <Reveal>
          <SectionHeading
            eyebrow="与传统方式对比"
            title="同一段内容，四种方式，差别一目了然"
            desc="人工翻译质量好但慢且贵；传统机器翻译快但不懂上下文；直接问大模型通顺却不受控。本平台把它们的长处合在一起。"
          />
        </Reveal>
        <Reveal className="mt-10">
          <CompareSection />
        </Reveal>
      </Section>

      {/* 4. 和 AI 面对面 */}
      <Section id="lumi" className="bg-surface/60">
        <Reveal>
          <SectionHeading
            eyebrow="和 AI 面对面"
            title={
              <>
                认识 Lumi：一个在听、在想、会回应你的数字人
              </>
            }
            desc="在同声传译里，她是你们的 AI 译员；在 AI 对话里，她陪你用外语聊天，听不懂可以随时打断。"
          />
        </Reveal>
        <Reveal className="mt-10">
          <LumiShowcase />
        </Reveal>
      </Section>

      {/* 5. 能力 bento */}
      <Section id="features">
        <Reveal>
          <SectionHeading eyebrow="能力一览" title="从一句话到一整份文档，从文字到声音和图片" desc="把鼠标移到卡片上，看看每个能力在做什么。" />
        </Reveal>
        <div className="mt-10">
          <Bento />
        </div>
      </Section>

      {/* 6. 长文档旅程 */}
      <Section className="bg-surface/60">
        <Reveal>
          <SectionHeading eyebrow="一份长文档的旅程" title="像译者一样：先通读，再动笔，最后逐段校对" />
        </Reveal>
        <div className="mt-10">
          <DocJourney />
        </div>
      </Section>

      {/* 7. 评测数据 */}
      <Section id="data">
        <Reveal>
          <SectionHeading
            eyebrow="用数据说话"
            title="每一项能力，都有实验数据支撑"
            desc="以下数字来自本项目的消融实验与同传、图片翻译实验（合成测试集，规模有限，详见实验报告的局限说明）。"
          />
        </Reveal>
        <div className="mt-10">
          <Stats />
        </div>
      </Section>

      {/* 8. 收尾 CTA + FAQ */}
      <Section className="bg-surface/60">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Reveal>
            <div className="relative overflow-hidden rounded-3xl bg-brand-gradient p-8 text-brand-foreground shadow-brand">
              <div aria-hidden className="absolute -top-16 -right-16 size-56 rounded-full bg-white/15 blur-2xl" />
              <h2 className="relative text-2xl font-semibold tracking-tight md:text-3xl">现在就开始，让翻译“想清楚再说”</h2>
              <p className="relative mt-3 text-sm leading-relaxed opacity-90">注册后即可使用翻译工作台、文档翻译、同声传译和 AI 对话。</p>
              <div className="relative mt-6">
                <AuthCta size="lg" className="bg-white text-brand hover:bg-white/90" />
              </div>
            </div>
          </Reveal>
          <Reveal delay={0.05}>
            <h2 className="mb-4 text-lg font-semibold">常见问题</h2>
            <Faq />
          </Reveal>
        </div>
      </Section>
    </>
  );
}
