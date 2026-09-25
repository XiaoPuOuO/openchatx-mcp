import {
  ArrowLeft,
  Blocks,
  CirclePlus,
  FileCode2,
  FileText,
  FolderOpen,
  RefreshCw,
  ScrollText,
  Sparkles,
  Trash2,
} from "lucide-react"
import { useEffect, useState } from "react"

import { LanguageSwitcher } from "../../components/LanguageSwitcher"
import { Button } from "../../components/ui/button"
import { Card, CardContent, CardHeader } from "../../components/ui/card"
import { useI18n } from "../../i18n"
import {
  createTool,
  createToolbox,
  createToolboxSkill,
  deleteRule,
  deleteTool,
  deleteToolbox,
  deleteToolboxSkill,
  fetchAgentInstructions,
  fetchRule,
  fetchRules,
  fetchToolboxes,
  openToolboxInFinder,
  reloadToolboxes,
  saveAgentInstructions,
  saveRule,
  setToolboxEnabled,
  setToolboxSkillEnabled,
  setToolEnabled,
} from "../../lib/api"
import type { LoadedRule, RuleMode, RuleSummary, ToolboxSnapshot } from "../../types"

type Tab = "tools" | "skills" | "rules"
const AGENTS_ITEM_ID = "__agents_md__"

interface RuleDraft {
  originalName?: string
  name: string
  mode: RuleMode
  description: string
  globs: string
  markdown: string
}

const EMPTY_RULE: RuleDraft = {
  name: "",
  mode: "manual",
  description: "",
  globs: "",
  markdown: "# Rule\n\n",
}

export function ToolboxManager({ onBack }: { onBack: () => void }) {
  const { t } = useI18n()
  const [toolboxes, setToolboxes] = useState<ToolboxSnapshot[]>([])
  const [rules, setRules] = useState<RuleSummary[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [agentInstructionsPath, setAgentInstructionsPath] = useState("")
  const [agentInstructions, setAgentInstructions] = useState("")
  const [savedAgentInstructions, setSavedAgentInstructions] = useState("")
  const [tab, setTab] = useState<Tab>("tools")
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>()
  const [error, setError] = useState<string>()
  const [message, setMessage] = useState<string>()

  useEffect(() => {
    void Promise.all([fetchToolboxes(), fetchRules(), fetchAgentInstructions()])
      .then(([items, currentRules, instructions]) => {
        setToolboxes(items)
        setRules(currentRules)
        setSelectedId(items[0]?.id)
        setAgentInstructionsPath(instructions.path)
        setAgentInstructions(instructions.content)
        setSavedAgentInstructions(instructions.content)
      })
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : String(loadError))
      )
  }, [])

  const selected = toolboxes.find((item) => item.id === selectedId)
  const agentsSelected = selectedId === AGENTS_ITEM_ID

  async function run(action: () => Promise<ToolboxSnapshot[]>, success?: string) {
    setError(undefined)
    setMessage(undefined)
    try {
      const next = await action()
      setToolboxes(next)
      if (success) setMessage(success)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError))
    }
  }

  async function addToolbox() {
    const id = window.prompt(t("toolboxes.promptFolder"))?.trim()
    if (!id) return
    await run(() => createToolbox(id), t("toolboxes.created", { id }))
    setSelectedId(id)
  }

  async function addTool() {
    if (!selected || selected.builtin) return
    const name = window.prompt(t("toolboxes.promptTool"))?.trim()
    if (!name) return
    await run(() => createTool(selected.id, name), t("toolboxes.createdTool", { name }))
  }

  async function addSkill() {
    if (!selected) return
    const name = window.prompt(t("toolboxes.promptSkill"))?.trim()
    if (!name) return
    await run(() => createToolboxSkill(selected.id, name), t("toolboxes.createdSkill", { name }))
  }

  async function openRule(rule: RuleSummary) {
    setError(undefined)
    try {
      const loaded = await fetchRule(rule.name)
      setRuleDraft(ruleToDraft(loaded))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    }
  }

  async function persistRule() {
    if (!ruleDraft?.name.trim()) return
    setError(undefined)
    try {
      const next = await saveRule({
        ...ruleDraft,
        name: ruleDraft.name.trim(),
        description: ruleDraft.description.trim() || undefined,
        globs: splitGlobs(ruleDraft.globs),
      })
      setRules(next)
      setRuleDraft(undefined)
      setMessage(t("toolboxes.ruleSaved"))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    }
  }

  async function removeRule(name: string) {
    if (!window.confirm(t("toolboxes.deleteRuleConfirm", { name }))) return
    try {
      setRules(await deleteRule(name))
      if (ruleDraft?.originalName === name) setRuleDraft(undefined)
      setMessage(t("toolboxes.deletedRule", { name }))
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
    }
  }

  async function removeToolbox() {
    if (!selected || selected.builtin) return
    if (!window.confirm(t("toolboxes.deleteConfirm", { id: selected.id }))) return
    await run(() => deleteToolbox(selected.id), t("toolboxes.deleted", { id: selected.id }))
    setSelectedId(toolboxes.find((box) => box.id !== selected.id)?.id)
  }

  async function persistAgentInstructions() {
    setError(undefined)
    try {
      const saved = await saveAgentInstructions(agentInstructions)
      setAgentInstructionsPath(saved.path)
      setAgentInstructions(saved.content)
      setSavedAgentInstructions(saved.content)
      setMessage(t("toolboxes.agentsSaved"))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    }
  }

  async function openFinder(kind?: "tool" | "skill", name?: string) {
    if (!selected) return
    try {
      const opened = await openToolboxInFinder(selected.id, kind, name)
      if (!opened) setMessage(t("toolboxes.mockFinder"))
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : String(openError))
    }
  }

  return (
    <main className="min-h-screen bg-muted/20">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={onBack} aria-label={t("common.back")}>
              <ArrowLeft className="size-4" />
            </Button>
            <div className="flex size-9 items-center justify-center rounded-lg bg-foreground text-background">
              <Blocks className="size-5" />
            </div>
            <div>
              <h1 className="text-base font-semibold">{t("toolboxes.title")}</h1>
              <p className="text-xs text-muted-foreground">{t("toolboxes.subtitle")}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <LanguageSwitcher />
            <Button
              variant="outline"
              onClick={() => void run(reloadToolboxes, t("toolboxes.reloaded"))}
            >
              <RefreshCw className="size-4" />
              {t("common.reload")}
            </Button>
            <Button onClick={() => void addToolbox()}>
              <CirclePlus className="size-4" />
              {t("toolboxes.new")}
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[1500px] gap-5 px-5 py-6 lg:grid-cols-[300px_1fr] lg:px-8">
        <Card className="overflow-hidden">
          <CardHeader className="border-b">
            <h2 className="text-sm font-semibold">{t("toolboxes.folders")}</h2>
            <p className="text-xs text-muted-foreground">
              {t("toolboxes.count", { count: toolboxes.length })}
            </p>
          </CardHeader>
          <CardContent className="space-y-1 p-2">
            <button
              type="button"
              onClick={() => setSelectedId(AGENTS_ITEM_ID)}
              className={`flex w-full items-center justify-between rounded-lg px-3 py-3 text-left ${
                agentsSelected ? "bg-muted" : "hover:bg-muted/60"
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <FileText className="size-4 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">AGENTS.md</span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {t("toolboxes.agentsTemplate")}
                </p>
              </div>
            </button>
            {toolboxes.map((box) => (
              <button
                key={box.id}
                type="button"
                onClick={() => setSelectedId(box.id)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-3 text-left ${
                  selectedId === box.id ? "bg-muted" : "hover:bg-muted/60"
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2 rounded-full ${box.enabled ? "bg-emerald-500" : "bg-neutral-300"}`}
                    />
                    <span className="truncate text-sm font-medium">{box.name}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{box.id}</p>
                </div>
                {box.builtin ? (
                  <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                    {t("common.builtIn")}
                  </span>
                ) : null}
              </button>
            ))}
          </CardContent>
        </Card>

        <div className="space-y-3">
          {agentsSelected ? (
            <AgentsEditor
              path={agentInstructionsPath}
              value={agentInstructions}
              dirty={agentInstructions !== savedAgentInstructions}
              onChange={setAgentInstructions}
              onSave={() => void persistAgentInstructions()}
              t={t}
            />
          ) : selected ? (
            <Card className="overflow-hidden">
              <CardHeader className="flex-row items-start justify-between border-b">
                <div>
                  <h2 className="text-base font-semibold">{selected.name}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {selected.description ?? selected.path}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 text-xs">
                    {t("common.enabled")}
                    <input
                      type="checkbox"
                      checked={selected.enabled}
                      disabled={selected.tools.some((tool) => tool.required)}
                      onChange={(event) =>
                        void run(() => setToolboxEnabled(selected.id, event.target.checked))
                      }
                    />
                  </label>
                  <Button variant="outline" size="sm" onClick={() => void openFinder()}>
                    <FolderOpen className="size-3.5" />
                    {t("common.openInFinder")}
                  </Button>
                  {!selected.builtin ? (
                    <Button variant="ghost" size="sm" onClick={() => void removeToolbox()}>
                      <Trash2 className="size-3.5" />
                      {t("common.delete")}
                    </Button>
                  ) : null}
                </div>
              </CardHeader>

              <div className="flex border-b bg-muted/20 px-3 pt-2">
                {(["tools", "skills", "rules"] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setTab(item)}
                    className={`rounded-t-lg px-4 py-2 text-sm font-medium ${
                      tab === item
                        ? "border border-b-background bg-background text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {item === "tools"
                      ? t("toolboxes.tools")
                      : item === "skills"
                        ? t("toolboxes.skills")
                        : t("toolboxes.rules")}
                  </button>
                ))}
              </div>

              {tab === "tools" ? (
                <ToolContent
                  selected={selected}
                  onAdd={() => void addTool()}
                  onOpen={(name: string) => void openFinder("tool", name)}
                  onDelete={(name: string) => {
                    if (
                      !selected.builtin &&
                      window.confirm(t("toolboxes.deleteToolConfirm", { name }))
                    ) {
                      void run(
                        () => deleteTool(selected.id, name),
                        t("toolboxes.deletedTool", { name })
                      )
                    }
                  }}
                  onToggle={(name: string, enabled: boolean) =>
                    void run(() => setToolEnabled(selected.id, name, enabled))
                  }
                  t={t}
                />
              ) : tab === "skills" ? (
                <SkillContent
                  selected={selected}
                  onAdd={() => void addSkill()}
                  onOpen={(name: string) => void openFinder("skill", name)}
                  onDelete={(name: string) => {
                    if (window.confirm(t("toolboxes.deleteSkillConfirm", { name }))) {
                      void run(
                        () => deleteToolboxSkill(selected.id, name),
                        t("toolboxes.deletedSkill", { name })
                      )
                    }
                  }}
                  onToggle={(name: string, enabled: boolean) =>
                    void run(() => setToolboxSkillEnabled(selected.id, name, enabled))
                  }
                  t={t}
                />
              ) : (
                <RulesContent
                  rules={rules}
                  draft={ruleDraft}
                  setDraft={setRuleDraft}
                  onAdd={() => setRuleDraft({ ...EMPTY_RULE })}
                  onEdit={(rule: RuleSummary) => void openRule(rule)}
                  onDelete={(name: string) => void removeRule(name)}
                  onSave={() => void persistRule()}
                  t={t}
                />
              )}
            </Card>
          ) : null}

          {error ? (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}
          {message ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              {message}
            </div>
          ) : null}
        </div>
      </div>
    </main>
  )
}

function AgentsEditor({
  path,
  value,
  dirty,
  onChange,
  onSave,
  t,
}: {
  path: string
  value: string
  dirty: boolean
  onChange: (value: string) => void
  onSave: () => void
  t: (key: string, values?: Record<string, string | number>) => string
}) {
  const placeholders = [
    ["{{MODE}}", t("toolboxes.placeholderMode")],
    ["{{TASK_ID}}", t("toolboxes.placeholderTaskId")],
    ["{{MODE_INSTRUCTIONS}}", t("toolboxes.placeholderModeInstructions")],
    ["{{PROJECT_CONTEXT}}", t("toolboxes.placeholderProjectContext")],
    ["{{CAPABILITY_CATALOG}}", t("toolboxes.placeholderCapabilityCatalog")],
    ["{{ALWAYS_RULES}}", t("toolboxes.placeholderAlwaysRules")],
  ] as const

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-start justify-between border-b">
        <div>
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-muted-foreground" />
            <h2 className="text-base font-semibold">AGENTS.md</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{path}</p>
        </div>
        <Button onClick={onSave} disabled={!dirty}>
          {t("common.save")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4 p-5">
        <div>
          <h3 className="text-sm font-medium">{t("toolboxes.agentsTemplateTitle")}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {t("toolboxes.agentsTemplateHint")}
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {placeholders.map(([token, description]) => (
            <div key={token} className="rounded-lg border bg-muted/20 px-3 py-2">
              <code className="text-[11px] font-medium">{token}</code>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{description}</p>
            </div>
          ))}
        </div>
        <textarea
          className="min-h-[560px] w-full resize-y rounded-lg border bg-background px-4 py-3 font-mono text-xs leading-5 outline-none focus:ring-2 focus:ring-[rgb(0_122_255/0.22)]"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
        />
      </CardContent>
    </Card>
  )
}

function ToolContent({ selected, onAdd, onOpen, onDelete, onToggle, t }: any) {
  return (
    <div>
      <div className="flex items-center justify-between px-5 py-3">
        <span className="text-xs text-muted-foreground">
          {t("toolboxes.toolsCount", { count: selected.tools.length })}
        </span>
        {!selected.builtin ? (
          <Button variant="outline" size="sm" onClick={onAdd}>
            <CirclePlus className="size-3.5" />
            {t("toolboxes.addTsTool")}
          </Button>
        ) : null}
      </div>
      <div className="divide-y border-t">
        {selected.tools.map((tool: any) => (
          <div key={tool.name} className="flex items-center justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <FileCode2 className="size-4 text-muted-foreground" />
                <span className="font-mono text-sm font-medium">{tool.name}</span>
              </div>
              <p
                className={`mt-1 text-xs ${tool.error ? "text-red-600" : "text-muted-foreground"}`}
              >
                {tool.error ?? tool.description ?? tool.path ?? t("toolboxes.tools")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {tool.path ? (
                <Button variant="ghost" size="sm" onClick={() => onOpen(tool.name)}>
                  <FolderOpen className="size-3.5" />
                </Button>
              ) : null}
              {!selected.builtin ? (
                <Button variant="ghost" size="sm" onClick={() => onDelete(tool.name)}>
                  <Trash2 className="size-3.5" />
                </Button>
              ) : null}
              <input
                type="checkbox"
                checked={tool.enabled}
                disabled={tool.required}
                onChange={(e) => onToggle(tool.name, e.target.checked)}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SkillContent({ selected, onAdd, onOpen, onDelete, onToggle, t }: any) {
  return (
    <div>
      <div className="flex items-center justify-between px-5 py-3">
        <span className="text-xs text-muted-foreground">
          {t("toolboxes.skillsCount", { count: selected.skills.length })}
        </span>
        <Button variant="outline" size="sm" onClick={onAdd}>
          <CirclePlus className="size-3.5" />
          {t("toolboxes.addSkill")}
        </Button>
      </div>
      <div className="divide-y border-t">
        {selected.skills.length === 0 ? (
          <div className="px-5 py-8 text-sm text-muted-foreground">{t("toolboxes.noSkills")}</div>
        ) : (
          selected.skills.map((skill: any) => (
            <div key={skill.name} className="flex items-center justify-between gap-4 px-5 py-4">
              <div>
                <div className="flex items-center gap-2">
                  <Sparkles className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{skill.name}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {skill.description ?? skill.path}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => onOpen(skill.name)}>
                  <FolderOpen className="size-3.5" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onDelete(skill.name)}>
                  <Trash2 className="size-3.5" />
                </Button>
                <input
                  type="checkbox"
                  checked={skill.enabled}
                  onChange={(e) => onToggle(skill.name, e.target.checked)}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function RulesContent({ rules, draft, setDraft, onAdd, onEdit, onDelete, onSave, t }: any) {
  return (
    <div>
      <div className="flex items-center justify-between px-5 py-3">
        <span className="text-xs text-muted-foreground">
          {t("toolboxes.rulesCount", { count: rules.length })}
        </span>
        <Button variant="outline" size="sm" onClick={onAdd}>
          <CirclePlus className="size-3.5" />
          {t("toolboxes.addRule")}
        </Button>
      </div>
      {draft ? (
        <div className="border-t bg-muted/10 p-5">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-xs font-medium">
              {t("toolboxes.ruleName")}
              <input
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={draft.name}
                disabled={Boolean(draft.originalName)}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="text-xs font-medium">
              {t("toolboxes.ruleMode")}
              <select
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={draft.mode}
                onChange={(e) => setDraft({ ...draft, mode: e.target.value as RuleMode })}
              >
                <option value="always">Always</option>
                <option value="auto_attached">Auto Attached</option>
                <option value="agent_requested">Agent Requested</option>
                <option value="manual">Manual</option>
              </select>
            </label>
          </div>
          {draft.mode === "agent_requested" ? (
            <label className="mt-3 block text-xs font-medium">
              {t("toolboxes.ruleDescription")}
              <input
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
          ) : null}
          {draft.mode === "auto_attached" ? (
            <label className="mt-3 block text-xs font-medium">
              {t("toolboxes.ruleGlobs")}
              <input
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={draft.globs}
                onChange={(e) => setDraft({ ...draft, globs: e.target.value })}
                placeholder="src/**/*.tsx, **/*.jsx"
              />
            </label>
          ) : null}
          <label className="mt-3 block text-xs font-medium">
            {t("toolboxes.ruleMarkdown")}
            <textarea
              className="mt-1 min-h-48 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
              value={draft.markdown}
              onChange={(e) => setDraft({ ...draft, markdown: e.target.value })}
            />
          </label>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDraft(undefined)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={onSave}>{t("common.save")}</Button>
          </div>
        </div>
      ) : null}
      <div className="divide-y border-t">
        {rules.length === 0 ? (
          <div className="px-5 py-8 text-sm text-muted-foreground">{t("toolboxes.noRules")}</div>
        ) : (
          rules.map((rule: RuleSummary) => (
            <div key={rule.name} className="flex items-center justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <ScrollText className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">{rule.name}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                    {modeLabel(rule.mode)}
                  </span>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {rule.description ??
                    (rule.globs.length ? rule.globs.join(", ") : t("toolboxes.ruleManualHint"))}
                </p>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => onEdit(rule)}>
                  {t("common.edit")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => onDelete(rule.name)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function ruleToDraft(rule: LoadedRule): RuleDraft {
  return {
    originalName: rule.name,
    name: rule.name,
    mode: rule.mode,
    description: rule.description ?? "",
    globs: rule.globs.join(", "),
    markdown: rule.markdown,
  }
}

function splitGlobs(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function modeLabel(mode: RuleMode): string {
  if (mode === "always") return "Always"
  if (mode === "auto_attached") return "Auto Attached"
  if (mode === "agent_requested") return "Agent Requested"
  return "Manual"
}
