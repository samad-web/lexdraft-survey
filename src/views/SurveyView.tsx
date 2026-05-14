import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { BackgroundBoxes } from '@/components/BackgroundBoxes';
import { api } from '@/lib/api';
import {
  STEPS,
  SPEND_BY_COHORT,
  WILL_PAY_BY_COHORT,
  COHORT_LABELS,
  getCohort,
  isFieldVisible,
  isOptionVisible,
  pickedOther,
  step4FieldsFor,
  type Answers,
  type AnswerValue,
  type Cohort,
  type Field,
  type Option,
  type StepDef,
} from '@/lib/survey-questions';

// =============================================================================
// SurveyView - public market-research questionnaire at /survey.
//
// Renders the LexDraft practitioner study defined in
// apps/web/src/lib/survey-questions.ts. Multi-step wizard with a segmented
// progress indicator (same idiom as AuthView), cohort-aware branching, and
// inline-revealing "Other" text fields. Hidden fields are never submitted -
// the API + DB enforce the same rules via Zod and CHECK constraints.
//
// Composes existing tokens (.card, .input, .label, .btn, .btn-primary, .btn-lg,
// .btn-block, .eyebrow, .body-md, .muted, .divider) - no new design patterns.
//
// Draft persistence
// -----------------
// On the user's first interaction past the Welcome card we POST to
// /api/survey/drafts to allocate a row, stash the id (+ a snapshot of state)
// in localStorage, and PUT incremental snapshots whenever answers / other
// texts / position change (debounced 800ms). On submit success the local
// draft is cleared. If the page reloads mid-survey, localStorage restores
// the user's progress; the server-side row is the operator's view of
// abandoned responses.
// =============================================================================

const DRAFT_LOCAL_KEY = 'lexdraft-survey-draft-v1';

interface LocalDraft {
  id: string;
  answers: Answers;
  otherTexts: Record<string, string>;
  currentIndex: number;
}

function loadLocalDraft(): LocalDraft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_LOCAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalDraft>;
    if (typeof parsed?.id !== 'string') return null;
    return {
      id: parsed.id,
      answers: (parsed.answers as Answers) ?? {},
      otherTexts: (parsed.otherTexts as Record<string, string>) ?? {},
      currentIndex: typeof parsed.currentIndex === 'number' ? parsed.currentIndex : -1,
    };
  } catch {
    return null;
  }
}

function saveLocalDraft(d: LocalDraft): void {
  try {
    window.localStorage.setItem(DRAFT_LOCAL_KEY, JSON.stringify(d));
  } catch {
    // Quota exceeded / private browsing → fall through silently. The
    // server-side draft keeps working; we just lose cross-reload restore.
  }
}

function clearLocalDraft(): void {
  try {
    window.localStorage.removeItem(DRAFT_LOCAL_KEY);
  } catch {
    // ignore
  }
}

function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <>
      <div className="eyebrow" style={{ marginBottom: 8 }}>SirahDigital practitioner study</div>
      <h1 className="heading-xl" style={{ marginBottom: 12 }}>
        Help shape an AI tool built for Indian advocates
      </h1>
      <p className="body-md muted" style={{ marginBottom: 24 }}>
        Ten short steps, about eight minutes. Confidential, India-hosted, and DPDP-compliant.
        Early respondents get free beta access.
      </p>
      <div
        className="card-cream"
        style={{ padding: 16, marginBottom: 24, display: 'grid', gap: 6 }}
      >
        <div className="body-sm" style={{ color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>~8 minutes.</strong> Mostly tick-boxes
          with the occasional short answer. Nothing lengthy.
        </div>
        <div className="body-sm" style={{ color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>Beta access.</strong> Tell us at the end if
          you'd like early access or a paid pilot.
        </div>
      </div>
      <button type="button" className="btn btn-primary btn-lg btn-block" onClick={onStart}>
        Begin
      </button>
    </>
  );
}

interface VisibleEntry {
  // Steps in GROUPED_STEPS render all their visible fields on one screen
  // (e.g. Step 2 contact details, Step 3 role/years/firmSize - these belong
  // logically to one prompt). Every other step's fields are rendered
  // one-per-screen so users move through the survey one question at a time.
  fields: Field[];
  stepIndex: number;   // 2..11 from STEPS
  stepTitle: string;
  // Only present for multi-field entries; used as the screen's heading +
  // sub-helper. For single-field entries we fall back to the field's prompt.
  groupHeading?: string;
  groupHelper?: string;
  // Layout for multi-field entries: 'columns' (default, auto-fit multi-col)
  // or 'stack' (single column, fields stacked top-to-bottom).
  layout?: 'columns' | 'stack';
}

// Steps whose visible fields should be grouped onto one screen.
//   2  → Contact details (name, email, phone, city, bar council)
//   3  → Role / years / firm size (cohort-setting trio)
//   4  → Firm/chamber details - departments, support staff, procurement /
//         decision-makers / solo decision (all cohort-dependent)
//   11 → Follow-up opt-ins (interview, beta, pilot, founder call) - the
//         four "future contact" questions render together; submitting from
//         this screen transitions the same screen to the Step 12 thank-you
//         content rather than navigating to a separate /survey/thanks page.
const GROUPED_STEPS: ReadonlySet<number> = new Set([2, 3, 4, 11]);

// Smaller pairings inside a non-grouped step - emit the listed field names
// onto a single entry instead of one entry per field. The fields keep their
// individual labels (no extra group heading); the progress bar's step title
// already names the section. Useful when two adjacent questions in a step
// belong together but the rest of the step doesn't.
//
// Optional `layout`:
//   'columns' (default) - multi-column packing, balances heights.
//   'stack' - single-column flex stack; use when one field is a conditional
//              follow-up to another and should sit below it.
interface FieldGroup {
  fields: ReadonlyArray<string>;
  layout?: 'columns' | 'stack';
}

const FIELD_GROUPS: ReadonlyArray<FieldGroup> = [
  // Step 6 Q11 + Q12 share one screen, multi-column packs the two checkbox
  // lists side-by-side.
  { fields: ['research', 'drafting'] },
  // "Do you use case-mgmt software?" + the "if yes, which one?" follow-up
  // render together. caseMgmtSpec stays hidden until caseMgmt === 'yes',
  // and when it reveals it sits BELOW the radio rather than alongside it.
  { fields: ['caseMgmt', 'caseMgmtSpec'], layout: 'stack' },
];

export function SurveyView() {
  // Restore any in-progress draft from localStorage on first mount. We do
  // this lazily inside useState initialisers so the restore is a one-time
  // boot step - never re-runs on later renders.
  const restored = useMemo(() => loadLocalDraft(), []);

  // -1 = Welcome card; 0..N-1 = nth visible question; submitted = post-submit
  // thank-you state (same screen, no /survey/thanks navigation).
  const [currentIndex, setCurrentIndex] = useState<number>(restored?.currentIndex ?? -1);
  // Highest question index the user has reached. Drives the numbered step
  // pager: already-reached indices are free-jumpable; further indices are
  // gated behind required-field validation.
  const [maxReached, setMaxReached] = useState<number>(restored?.currentIndex ?? -1);
  const [answers, setAnswers] = useState<Answers>(restored?.answers ?? {});
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>(restored?.otherTexts ?? {});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [submittedPayload, setSubmittedPayload] = useState<Record<string, unknown> | null>(null);

  // Server-side draft id. Persisted across reloads via localStorage; null
  // until the user makes their first interaction past Welcome (which is the
  // earliest moment we POST /api/survey/drafts to allocate a row).
  const draftIdRef = useRef<string | null>(restored?.id ?? null);

  // Debounced sync to PUT /api/survey/drafts/:id. We schedule a single
  // pending timer; new answer changes reset it. Captured-at-fire snapshots
  // of state mean the in-flight PUT carries the latest values.
  const pendingTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (submitted) return; // post-submit: stop syncing
    if (!draftIdRef.current) return; // pre-Welcome: no row to update yet
    if (pendingTimerRef.current !== null) {
      window.clearTimeout(pendingTimerRef.current);
    }
    pendingTimerRef.current = window.setTimeout(() => {
      pendingTimerRef.current = null;
      const id = draftIdRef.current;
      if (!id) return;
      const body = { answers, otherTexts, currentIndex };
      saveLocalDraft({ id, ...body });
      // Fire-and-forget; failures don't break the survey. If the server
      // says the draft is gone (404) or errored on a stale row (500), drop
      // the id locally so the next interaction can allocate a fresh one.
      void api
        .put(`/survey/drafts/${id}`, body)
        .catch((err: { response?: { status?: number } } | null) => {
          const status = err?.response?.status;
          if (status === 404 || status === 500) {
            draftIdRef.current = null;
            clearLocalDraft();
          }
        });
    }, 800);
    return () => {
      if (pendingTimerRef.current !== null) {
        window.clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
  }, [answers, otherTexts, currentIndex, submitted]);

  /** Allocate the server-side draft row on the user's first interaction. */
  const ensureDraft = async (): Promise<void> => {
    if (draftIdRef.current) return;
    try {
      const res = await api.post<{ id: string }>('/survey/drafts');
      draftIdRef.current = res.id;
      saveLocalDraft({
        id: res.id,
        answers,
        otherTexts,
        currentIndex,
      });
    } catch {
      // Draft allocation failed - proceed without server-side draft sync.
      // localStorage still saves on reload via subsequent saveLocalDraft
      // calls in the debounced effect (guarded by draftIdRef.current).
    }
  };

  const cohort = getCohort(answers);

  // Flat, ordered list of every question that is currently visible. Cohort
  // and AI-usage branching can shrink/grow this list as answers change; the
  // current question is identified by index INTO this list, so when the list
  // changes the user's "position" naturally tracks the new flow.
  const visibleEntries = useMemo<VisibleEntry[]>(() => {
    const out: VisibleEntry[] = [];
    // Track which FIELD_GROUPS have already been emitted so we don't emit
    // duplicate entries when iterating each member of the group.
    const emittedFieldGroups = new Set<number>();

    for (const step of STEPS) {
      const visible = fieldsForStep(step, cohort).filter((f) => isFieldVisible(f, answers));
      if (visible.length === 0) continue;

      if (GROUPED_STEPS.has(step.index)) {
        out.push({
          fields: visible,
          stepIndex: step.index,
          stepTitle: step.title,
          groupHeading: step.title,
          groupHelper: step.helper,
        });
        continue;
      }

      for (const f of visible) {
        const groupIdx = FIELD_GROUPS.findIndex((g) => g.fields.includes(f.name));
        if (groupIdx >= 0) {
          if (emittedFieldGroups.has(groupIdx)) continue;
          emittedFieldGroups.add(groupIdx);

          const groupCfg = FIELD_GROUPS[groupIdx]!;
          // Emit in the group's declared order, skipping any members not
          // currently visible (e.g. hidden by AI-usage branching).
          const groupFields = groupCfg.fields
            .map((name) => visible.find((v) => v.name === name))
            .filter((v): v is Field => v !== undefined);
          if (groupFields.length === 0) continue;
          out.push({
            fields: groupFields,
            stepIndex: step.index,
            stepTitle: step.title,
            layout: groupCfg.layout,
            // No groupHeading: the progress bar already labels the step,
            // and each field keeps its own .label below.
          });
        } else {
          out.push({ fields: [f], stepIndex: step.index, stepTitle: step.title });
        }
      }
    }
    return out;
  }, [answers, cohort]);

  const isWelcome = currentIndex < 0;
  const total = visibleEntries.length;
  const safeIndex = Math.max(0, Math.min(currentIndex, total - 1));
  const current = !isWelcome ? visibleEntries[safeIndex] : null;
  const onLastQuestion = !isWelcome && safeIndex >= total - 1;
  // Numbers in the pager are revealed progressively so the respondent doesn't
  // see the total count upfront. Include `safeIndex` so the current step is
  // always visible even before the maxReached bump effect runs.
  const visibleSteps = isWelcome ? 0 : Math.max(maxReached, safeIndex) + 1;

  // ---------------------------------------------------------------------------
  // Submission
  // ---------------------------------------------------------------------------

  const buildPayload = (): Record<string, unknown> => {
    const visibleNames = new Set(
      visibleEntries.flatMap((e) => e.fields.map((f) => f.name)),
    );
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(answers)) {
      if (!visibleNames.has(name)) continue;
      if (value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      out[name] = value;
    }
    const otherOut: Record<string, string> = {};
    for (const entry of visibleEntries) {
      for (const field of entry.fields) {
        if (!field.hasOther) continue;
        const matched = pickedOther(field, answers[field.name]);
        const text = otherTexts[field.name]?.trim();
        if (matched && text) {
          otherOut[field.name] = text;
        }
      }
    }
    out.otherTexts = otherOut;
    return out;
  };

  const submitPayload = async () => {
    const errs = validateAllRequired(answers);
    if (errs) {
      setStepError(errs);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload = buildPayload();
      await api.post('/survey', payload);
      // Stamp the draft as completed (best-effort; analytics-only) and clear
      // local persistence so a reload starts fresh.
      if (draftIdRef.current) {
        void api
          .put(`/survey/drafts/${draftIdRef.current}`, { completed: true })
          .catch(() => undefined);
      }
      clearLocalDraft();
      setSubmittedPayload(payload);
      setSubmitted(true);
      setSubmitting(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      const msg =
        (err as { response?: { data?: { error?: string } } } | null)?.response?.data?.error
        ?? (err instanceof Error ? err.message : 'Submission failed. Please try again.');
      setSubmitError(msg);
      setSubmitting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Per-question navigation
  // ---------------------------------------------------------------------------

  // Watermark grows monotonically with currentIndex so it survives back-jumps.
  useEffect(() => {
    if (currentIndex > maxReached) setMaxReached(currentIndex);
  }, [currentIndex, maxReached]);

  /**
   * Jump to a specific question index via the numbered pager.
   * - Backward / already-reached: free.
   * - Forward: validate each intervening step. If a required field is missing
   *   we stop at the first failing step and surface the same error banner
   *   that `goNext` uses, so the user can't skip past unanswered questions.
   */
  const jumpTo = (target: number) => {
    setStepError(null);
    if (target < 0 || target >= total) return;
    if (!isWelcome && target === safeIndex) return;
    if (isWelcome) {
      void ensureDraft();
    }
    if (target <= maxReached) {
      setCurrentIndex(target);
      return;
    }
    const startFrom = Math.max(0, currentIndex);
    for (let i = startFrom; i < target; i++) {
      const entry = visibleEntries[i];
      if (!entry) break;
      const missing = firstMissingRequired(entry.fields, answers, otherTexts);
      if (missing) {
        setCurrentIndex(i);
        setStepError(missing);
        return;
      }
    }
    setCurrentIndex(target);
  };

  const goNext = () => {
    setStepError(null);
    if (isWelcome) {
      // First interaction past Welcome - allocate the server-side draft row
      // so subsequent debounced PUTs have a target.
      void ensureDraft();
      setCurrentIndex(0);
      return;
    }
    if (!current) return;
    const missing = firstMissingRequired(current.fields, answers, otherTexts);
    if (missing) {
      setStepError(missing);
      return;
    }
    if (onLastQuestion) {
      void submitPayload();
      return;
    }
    setCurrentIndex((i) => Math.min(i + 1, total - 1));
  };

  const goPrev = () => {
    setStepError(null);
    setCurrentIndex((i) => Math.max(i - 1, -1));
  };

  const setAnswer = (name: string, value: AnswerValue) =>
    setAnswers((a) => ({ ...a, [name]: value }));
  const setOtherText = (name: string, value: string) =>
    setOtherTexts((o) => ({ ...o, [name]: value }));

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="survey-page">
      <BackgroundBoxes />
      <div className="survey-shell">
        <header className="survey-top">
          {/* Brand */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              justifyContent: 'center',
              marginBottom: 16,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-display)',
                fontSize: 22,
                fontWeight: 600,
                letterSpacing: '-0.015em',
              }}
            >
              Sirahdigital
            </span>
          </div>

          {/* Eyebrow - deliberately omits the total step count so the
              respondent doesn't see "X of N" upfront. */}
          <div
            className="mono"
            style={{ fontSize: 11, color: 'var(--text-tertiary)', textAlign: 'center' }}
          >
            {submitted
              ? 'COMPLETE · THANK YOU'
              : isWelcome
                ? 'WELCOME'
                : `${(current?.fields.length ?? 1) > 1 ? 'STEP' : 'QUESTION'} ${safeIndex + 1} · ${current?.stepTitle.toUpperCase()}`}
          </div>

          {/* Numbered pager - only the indices the user has actually reached
              are rendered, so the row grows as the survey progresses instead
              of revealing the total step count upfront. */}
          {!submitted && visibleSteps > 0 && (
            <StepsPager
              total={visibleSteps}
              currentIndex={isWelcome ? -1 : safeIndex}
              maxReached={maxReached}
              onJump={jumpTo}
            />
          )}
        </header>

        <main className="survey-body">
          <div className="card survey-card">
            {isWelcome && !submitted && <Welcome onStart={goNext} />}

            {submitted && (
              <ThankYouPanel payload={submittedPayload} />
            )}

            {!isWelcome && !submitted && current && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  goNext();
                }}
              >
                {current.groupHeading && (
                  <header style={{ marginBottom: 20 }}>
                    <h2 className="heading-lg" style={{ marginBottom: 4 }}>
                      {current.groupHeading}
                    </h2>
                    {current.groupHelper && (
                      <p className="body-sm muted">{current.groupHelper}</p>
                    )}
                  </header>
                )}

                <div
                  className={
                    current.fields.length > 1
                      ? current.layout === 'stack'
                        ? 'survey-fields-stack'
                        : 'survey-fields'
                      : undefined
                  }
                >
                  {current.fields.map((f) => (
                    <FieldRow
                      key={f.name}
                      field={f}
                      cohort={cohort}
                      value={answers[f.name]}
                      onChange={(v) => setAnswer(f.name, v)}
                      otherText={otherTexts[f.name] ?? ''}
                      onOtherTextChange={(v) => setOtherText(f.name, v)}
                      answers={answers}
                    />
                  ))}
                </div>

                {stepError && <ErrorBanner>{stepError}</ErrorBanner>}
                {submitError && <ErrorBanner>{submitError}</ErrorBanner>}

                {/* Hidden submit so Enter key advances the form */}
                <button type="submit" style={{ display: 'none' }} aria-hidden tabIndex={-1} />
              </form>
            )}
          </div>
        </main>

        {!isWelcome && !submitted && (
          <nav className="survey-nav">
            <button
              type="button"
              className="btn btn-lg"
              onClick={goPrev}
              style={{ flex: '0 0 auto' }}
            >
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary btn-lg"
              onClick={goNext}
              disabled={submitting}
              style={{ flex: 1 }}
            >
              {onLastQuestion
                ? submitting ? 'Submitting…' : 'Submit'
                : 'Continue'}
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// StepsPager - single-line, horizontally-scrollable list of question numbers.
// Auto-scrolls the active number into view so Next/Back keeps it visible.
// =============================================================================

function StepsPager({
  total,
  currentIndex,
  maxReached,
  onJump,
}: {
  total: number;
  currentIndex: number;
  maxReached: number;
  onJump: (i: number) => void;
}) {
  const listRef = useRef<HTMLElement | null>(null);
  const isFirstScroll = useRef(true);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (currentIndex < 0) return;
    const btn = list.querySelector<HTMLButtonElement>(
      `[data-step-index="${currentIndex}"]`,
    );
    // First scroll is instant so we don't see the item drift from its
    // padding-inline offset to true centre on mount; subsequent scrolls
    // animate as the user advances.
    btn?.scrollIntoView({
      behavior: isFirstScroll.current ? 'auto' : 'smooth',
      inline: 'center',
      block: 'nearest',
    });
    isFirstScroll.current = false;
  }, [currentIndex]);

  // Show the scrollbar only once the pager grows past 14 numbers. Below that
  // the row is short enough that the side mask + smooth scrollIntoView are a
  // clean enough indicator without a visible bar.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    list.classList.toggle('is-overflow', total > 14);
  }, [total]);

  return (
    <nav
      ref={listRef}
      className="survey-steps"
      aria-label="Survey question navigation"
    >
      {Array.from({ length: total }, (_, i) => {
        const isCurrent = i === currentIndex;
        const isReached = i <= maxReached;
        const cls = [
          'survey-step',
          isCurrent ? 'survey-step--current' : '',
          !isCurrent && isReached ? 'survey-step--visited' : '',
          !isCurrent && !isReached ? 'survey-step--future' : '',
        ].filter(Boolean).join(' ');
        return (
          <button
            key={i}
            type="button"
            className={cls}
            data-step-index={i}
            onClick={() => onJump(i)}
            aria-current={isCurrent ? 'step' : undefined}
            aria-label={`Go to question ${i + 1}`}
          >
            {isCurrent && (
              <motion.span
                layoutId="survey-step-pill"
                className="survey-step-pill"
                transition={{ type: 'spring', stiffness: 420, damping: 32, mass: 0.7 }}
                aria-hidden
              />
            )}
            <span className="survey-step-label">{i + 1}</span>
          </button>
        );
      })}
    </nav>
  );
}

// =============================================================================
// ThankYouPanel - Step 12 thank-you content shown inline once the survey is
// submitted (no /survey/thanks navigation). Visual style mirrors
// SurveyThanksView so direct-link visitors and inline submitters see the
// same confirmation shape.
// =============================================================================

function ThankYouPanel({
  payload,
}: {
  payload: Record<string, unknown> | null;
}) {
  const handleDownload = () => {
    if (!payload) return;
    const json = JSON.stringify({ submitted_at: new Date().toISOString(), ...payload }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lexdraft-survey-response-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ textAlign: 'center' }}>
      <Confetti />
      <header style={{ marginBottom: 20 }}>
        <div className="eyebrow">SirahDigital practitioner study</div>
        <h2 className="heading-lg" style={{ marginTop: 4 }}>Thank you for your time</h2>
      </header>

      <p className="body-md" style={{ marginBottom: 16, maxWidth: 480, marginLeft: 'auto', marginRight: 'auto' }}>
        Your response has been recorded. The findings shape an AI tool built for Indian advocates -
        your candour today goes directly into product decisions.
      </p>

      <div
        className="card-cream"
        style={{
          padding: 16,
          marginBottom: 20,
          maxWidth: 420,
          marginLeft: 'auto',
          marginRight: 'auto',
          textAlign: 'left',
        }}
      >
        <div className="body-sm" style={{ color: 'var(--text-secondary)', marginBottom: 6 }}>
          <strong style={{ color: 'var(--text-primary)' }}>What happens next</strong>
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)' }}>
          <li className="body-sm" style={{ marginBottom: 4 }}>
            If you opted in for a follow-up, we&apos;ll be in touch via the email you provided.
          </li>
          <li className="body-sm" style={{ marginBottom: 4 }}>
            Beta access invitations go out as features come online.
          </li>
          <li className="body-sm">
            All responses are stored on India servers in line with DPDP Act 2023.
          </li>
        </ul>
      </div>

      {payload && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-lg" onClick={handleDownload}>
            Download your response
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Confetti - one-shot monochrome burst on submit.
//
// Hand-rolled, no dependency. Pieces fall from above the viewport to below
// it via a CSS keyframe; each piece gets randomised inline left / size /
// rotation / duration so the burst looks organic. Shapes are restricted to
// the design system's monochrome palette plus the same SVG plus-mark used
// by BackgroundBoxes, so the confetti reads as part of the same visual
// language rather than a third-party party-popper drop-in.
// =============================================================================

type ConfettiShape = 'square' | 'rect' | 'thin' | 'plus';
interface ConfettiPieceCfg {
  id: number;
  leftPct: number;
  size: number;
  rotation: number;
  delay: number;
  duration: number;
  shape: ConfettiShape;
  shade: string;
  drift: number; // horizontal drift in px over the fall
}

const CONFETTI_SHADES = ['#0A0A0A', '#262626', '#404040', '#737373', '#A3A3A3', '#C8C8C8'];

function Confetti({ count = 70 }: { count?: number }) {
  // Respect users who've asked for reduced motion - skip the burst entirely.
  const reduced = useMemo(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }, []);

  const pieces = useMemo<ConfettiPieceCfg[]>(() => {
    if (reduced) return [];
    const shapes: ConfettiShape[] = ['square', 'rect', 'thin', 'plus'];
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      leftPct: Math.random() * 100,
      size: 6 + Math.random() * 10,
      rotation: Math.random() * 360,
      delay: Math.random() * 1.2,
      duration: 2.6 + Math.random() * 2.4,
      shape: shapes[Math.floor(Math.random() * shapes.length)]!,
      shade: CONFETTI_SHADES[Math.floor(Math.random() * CONFETTI_SHADES.length)]!,
      drift: (Math.random() - 0.5) * 120,
    }));
  }, [count, reduced]);

  // After the longest piece has had time to clear the viewport, unmount the
  // host so we don't leave 70 absolutely-positioned elements behind.
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    if (reduced) { setMounted(false); return; }
    const t = window.setTimeout(() => setMounted(false), 6500);
    return () => window.clearTimeout(t);
  }, [reduced]);

  if (!mounted || pieces.length === 0) return null;

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: 60,
      }}
    >
      {pieces.map((p) => <ConfettiPiece key={p.id} {...p} />)}
    </div>
  );
}

function ConfettiPiece(p: ConfettiPieceCfg) {
  const style: CSSProperties = {
    position: 'absolute',
    top: 0,
    left: `${p.leftPct}%`,
    width: p.shape === 'rect' ? p.size : p.shape === 'thin' ? Math.max(2, p.size * 0.2) : p.size,
    height: p.shape === 'rect' ? Math.max(3, p.size * 0.4) : p.size,
    background: p.shape === 'plus' ? 'transparent' : p.shade,
    color: p.shade,
    borderRadius: p.shape === 'thin' ? 1 : 2,
    animation: `survey-confetti-fall ${p.duration}s linear ${p.delay}s 1 forwards`,
    // Custom property consumed by the @keyframes; lets each piece carry its
    // own drift + rotation without us generating bespoke keyframes per piece.
    ['--cf-drift' as never]: `${p.drift}px`,
    ['--cf-rot-start' as never]: `${p.rotation}deg`,
    ['--cf-rot-end' as never]: `${p.rotation + 540}deg`,
    transform: `translate(0, -10vh) rotate(${p.rotation}deg)`,
    willChange: 'transform, opacity',
  };
  if (p.shape === 'plus') {
    return (
      <span style={style}>
        <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" d="M12 6v12m6-6H6" />
        </svg>
      </span>
    );
  }
  return <span style={style} />;
}

// =============================================================================
// FieldRow - single label + control + helper + (if applicable) Other reveal
// =============================================================================

function FieldRow({
  field,
  cohort,
  value,
  onChange,
  otherText,
  onOtherTextChange,
  answers,
}: {
  field: Field;
  cohort: Cohort | null;
  value: AnswerValue;
  onChange: (v: AnswerValue) => void;
  otherText: string;
  onOtherTextChange: (v: string) => void;
  answers: Answers;
}) {
  // Cohort-templated options for spend / willPay are injected here so the
  // declarative metadata stays clean.
  let options = field.options ?? [];
  if (field.name === 'spend' && cohort) options = SPEND_BY_COHORT[cohort];
  if (field.name === 'willPay' && cohort) options = WILL_PAY_BY_COHORT[cohort];

  const visibleOptions = options.filter((opt) => isOptionVisible(opt, cohort));
  const otherSelected = pickedOther(field, value);

  return (
    <div>
      <label className="label" htmlFor={inputId(field)}>
        {field.prompt}
        {field.required && (
          <span aria-hidden style={{ color: 'var(--danger)', marginLeft: 4 }}>*</span>
        )}
      </label>

      {renderControl(field, value, onChange, visibleOptions, answers)}

      {field.helper && (
        <p className="body-xs" style={{ marginTop: 6, color: 'var(--text-tertiary)' }}>
          {field.helper}
        </p>
      )}

      {field.hasOther && otherSelected && (
        <div style={{ marginTop: 10 }}>
          <input
            type="text"
            className="input"
            placeholder="Please specify"
            value={otherText}
            onChange={(e) => onOtherTextChange(e.target.value)}
            aria-label={`${field.prompt} - other`}
          />
        </div>
      )}
    </div>
  );
}

function inputId(field: Field): string {
  return `survey-${field.name}`;
}

function renderControl(
  field: Field,
  value: AnswerValue,
  onChange: (v: AnswerValue) => void,
  options: Option[],
  answers: Answers,
): ReactNode {
  switch (field.kind) {
    case 'text':
    case 'email': {
      const v = typeof value === 'string' ? value : '';
      return (
        <input
          id={inputId(field)}
          className="input"
          type={field.kind}
          value={v}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          autoComplete={field.autocomplete}
          required={field.required}
        />
      );
    }
    case 'tel': {
      const v = typeof value === 'string' ? value : '';
      return (
        <PhoneInput
          id={inputId(field)}
          value={v}
          onChange={onChange}
          placeholder={field.placeholder}
          autoComplete={field.autocomplete}
        />
      );
    }
    case 'textarea': {
      const v = typeof value === 'string' ? value : '';
      return (
        <textarea
          id={inputId(field)}
          className="input"
          rows={4}
          value={v}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          required={field.required}
        />
      );
    }
    case 'select': {
      const v = typeof value === 'string' ? value : '';
      return (
        <select
          id={inputId(field)}
          className="input"
          value={v}
          onChange={(e) => onChange(e.target.value || undefined)}
          required={field.required}
        >
          <option value="" disabled>
            Select…
          </option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }
    case 'radio': {
      const v = typeof value === 'string' ? value : '';
      return (
        <div role="radiogroup" className="survey-options">
          {options.map((opt) => (
            <OptionRow
              key={opt.value}
              kind="radio"
              name={field.name}
              optionValue={opt.value}
              label={opt.label}
              checked={v === opt.value}
              onChange={() => onChange(opt.value)}
            />
          ))}
        </div>
      );
    }
    case 'checkbox': {
      const arr = Array.isArray(value) ? value : [];
      const toggle = (slug: string) => {
        const next = arr.includes(slug) ? arr.filter((x) => x !== slug) : [...arr, slug];
        if (field.maxPick && next.length > field.maxPick) return;
        onChange(next);
      };
      return (
        <>
          <div role="group" className="survey-options">
            {options.map((opt) => (
              <OptionRow
                key={opt.value}
                kind="checkbox"
                name={field.name}
                optionValue={opt.value}
                label={opt.label}
                checked={arr.includes(opt.value)}
                onChange={() => toggle(opt.value)}
              />
            ))}
          </div>
          {field.maxPick && (
            <p className="body-xs" style={{ marginTop: 6, color: 'var(--text-tertiary)' }}>
              {arr.length} of {field.maxPick} selected
            </p>
          )}
        </>
      );
    }
    case 'rankings': {
      return (
        <RankingsControl
          field={field}
          value={Array.isArray(value) ? value : []}
          options={options}
          onChange={onChange}
          answers={answers}
        />
      );
    }
  }
}

// =============================================================================
// OptionRow - themed radio/checkbox tile (no new design patterns; native input
// hidden, label styled with the same border tokens used elsewhere).
// =============================================================================

function OptionRow({
  kind,
  name,
  optionValue,
  label,
  checked,
  onChange,
}: {
  kind: 'radio' | 'checkbox';
  name: string;
  optionValue: string;
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  const tileStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 14px',
    border: `1px solid ${checked ? 'var(--text-primary)' : 'var(--border-default)'}`,
    background: checked ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
    borderRadius: 'var(--radius-md)',
    cursor: 'pointer',
    transition: 'border-color 120ms, background 120ms',
  };
  const indicatorStyle: CSSProperties = {
    flex: '0 0 18px',
    width: 18,
    height: 18,
    borderRadius: kind === 'radio' ? '50%' : 4,
    border: `1px solid ${checked ? 'var(--text-primary)' : 'var(--border-strong)'}`,
    background: checked ? 'var(--text-primary)' : 'transparent',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  };

  return (
    <label style={tileStyle}>
      <input
        type={kind}
        name={name}
        value={optionValue}
        checked={checked}
        onChange={onChange}
        style={srOnlyStyle}
      />
      <span aria-hidden style={indicatorStyle}>
        {checked && kind === 'checkbox' && (
          <svg width={10} height={10} viewBox="0 0 10 10" fill="none">
            <path d="M1 5L4 8L9 2" stroke="var(--bg-base)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {checked && kind === 'radio' && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--bg-base)',
            }}
          />
        )}
      </span>
      <span className="body-md" style={{ color: 'var(--text-primary)' }}>{label}</span>
    </label>
  );
}

// =============================================================================
// PhoneInput - country-code dropdown + national number, combined into one
// stored string ("+91 9876543210"). Empty number => empty stored value so
// the required-field check fires correctly when only a code is selected.
// =============================================================================

interface CountryCode {
  code: string;
  country: string;
  // [min, max] national digit count (after the dial code). Mobile numbers,
  // not landlines, since the survey collects WhatsApp-preferred numbers.
  digits: [number, number];
}

// Curated: primary audience (India + neighbouring states), common
// destinations for diaspora respondents, and a few business hubs. The
// dropdown shows just the dial code; country name lives in the option's
// title attribute (browser tooltip on hover).
const COUNTRY_CODES: CountryCode[] = [
  { code: '+91',  country: 'India',         digits: [10, 10] },
  { code: '+977', country: 'Nepal',         digits: [10, 10] },
  { code: '+880', country: 'Bangladesh',    digits: [10, 10] },
  { code: '+94',  country: 'Sri Lanka',     digits: [9, 9] },
  { code: '+975', country: 'Bhutan',        digits: [8, 8] },
  { code: '+960', country: 'Maldives',      digits: [7, 7] },
  { code: '+92',  country: 'Pakistan',      digits: [10, 10] },
  { code: '+971', country: 'UAE',           digits: [9, 9] },
  { code: '+966', country: 'Saudi Arabia',  digits: [9, 9] },
  { code: '+974', country: 'Qatar',         digits: [8, 8] },
  { code: '+65',  country: 'Singapore',     digits: [8, 8] },
  { code: '+60',  country: 'Malaysia',      digits: [9, 10] },
  { code: '+1',   country: 'US / Canada',   digits: [10, 10] },
  { code: '+44',  country: 'UK',            digits: [10, 10] },
  { code: '+61',  country: 'Australia',     digits: [9, 9] },
];

function findCountryCode(code: string): CountryCode {
  return COUNTRY_CODES.find((c) => c.code === code) ?? COUNTRY_CODES[0]!;
}

function digitsLabel(meta: CountryCode): string {
  const [min, max] = meta.digits;
  return min === max ? `${max} digits` : `${min}-${max} digits`;
}

const DEFAULT_COUNTRY_CODE = '+91';

function parsePhone(raw: string): { code: string; rest: string } {
  if (!raw) return { code: DEFAULT_COUNTRY_CODE, rest: '' };
  // Greedy match: try the longest codes first so '+91' doesn't shadow '+960'.
  const codes = [...COUNTRY_CODES.map((c) => c.code)].sort((a, b) => b.length - a.length);
  for (const code of codes) {
    if (raw.startsWith(code)) {
      return { code, rest: raw.slice(code.length).trimStart() };
    }
  }
  return { code: DEFAULT_COUNTRY_CODE, rest: raw };
}

function PhoneInput({
  id,
  value,
  onChange,
  autoComplete,
}: {
  id: string;
  value: string;
  onChange: (v: AnswerValue) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  // Local state for the two halves - see the previous comment on why we
  // can't re-derive these from the parent's combined value every render.
  const [code, setCode] = useState<string>(() => parsePhone(value).code);
  const [rest, setRest] = useState<string>(() => parsePhone(value).rest);

  const meta = findCountryCode(code);
  const [, maxDigits] = meta.digits;

  // Strip non-digits and cap to the country's max length. Phone numbers are
  // stored digits-only so the value going to the server is unambiguous.
  const sanitise = (raw: string, max: number) => raw.replace(/\D/g, '').slice(0, max);

  const propagate = (c: string, r: string) => {
    if (r === '') onChange('');
    else onChange(`${c} ${r}`);
  };

  const handleCode = (next: string) => {
    // Re-truncate the existing number if the new country has a shorter limit.
    const nextMax = findCountryCode(next).digits[1];
    const truncated = sanitise(rest, nextMax);
    setCode(next);
    setRest(truncated);
    propagate(next, truncated);
  };

  const handleRest = (next: string) => {
    const digits = sanitise(next, maxDigits);
    setRest(digits);
    propagate(code, digits);
  };

  return (
    <div className="phone-input">
      <select
        className="input"
        value={code}
        onChange={(e) => handleCode(e.target.value)}
        aria-label="Country code"
      >
        {COUNTRY_CODES.map((c) => (
          <option key={c.code} value={c.code} title={`${c.country} (${c.code})`}>
            {c.code}
          </option>
        ))}
      </select>
      <input
        id={id}
        className="input"
        type="tel"
        inputMode="numeric"
        value={rest}
        onChange={(e) => handleRest(e.target.value)}
        placeholder={digitsLabel(meta)}
        maxLength={maxDigits}
        autoComplete={autoComplete ?? 'tel-national'}
      />
    </div>
  );
}

// =============================================================================
// RankingsControl - tap-to-rank top-3 (matches lexdraft-survey.md §3 Step 7).
// =============================================================================

function RankingsControl({
  field,
  value,
  options,
  onChange,
  answers,
}: {
  field: Field;
  value: string[];
  options: Option[];
  onChange: (v: AnswerValue) => void;
  answers: Answers;
}) {
  void answers; // reserved for future cohort-aware ranking hints
  const max = 3;
  const ranked = value;

  const toggle = (slug: string) => {
    const idx = ranked.indexOf(slug);
    if (idx >= 0) {
      onChange(ranked.filter((x) => x !== slug));
      return;
    }
    if (ranked.length >= max) return;
    onChange([...ranked, slug]);
  };

  return (
    <>
      <div className="survey-options" role="listbox" aria-label={field.prompt}>
        {options.map((opt) => {
          const idx = ranked.indexOf(opt.value);
          const selected = idx >= 0;
          const disabled = !selected && ranked.length >= max;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggle(opt.value)}
              disabled={disabled}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 14px',
                border: `1px solid ${selected ? 'var(--text-primary)' : 'var(--border-default)'}`,
                background: selected ? 'var(--bg-surface-2)' : 'var(--bg-surface)',
                borderRadius: 'var(--radius-md)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.5 : 1,
                textAlign: 'left',
                fontSize: 15,
                color: 'var(--text-primary)',
                transition: 'border-color 120ms, background 120ms',
              }}
            >
              <span
                style={{
                  flex: '0 0 22px',
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  border: `1px solid ${selected ? 'var(--text-primary)' : 'var(--border-strong)'}`,
                  background: selected ? 'var(--text-primary)' : 'transparent',
                  color: selected ? 'var(--bg-base)' : 'var(--text-tertiary)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {selected ? idx + 1 : ''}
              </span>
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

// =============================================================================
// Inline error banner - same role/styling as AuthView's failure block.
// =============================================================================

function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      style={{
        marginTop: 20,
        fontSize: 13,
        color: 'var(--danger)',
        background: 'var(--danger-bg)',
        border: '1px solid var(--danger)',
        borderRadius: 'var(--radius-md)',
        padding: '10px 12px',
      }}
    >
      {children}
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function fieldsForStep(step: StepDef, cohort: Cohort | null): Field[] {
  if (step.variants && step.variants.length > 0) {
    return step4FieldsFor(cohort);
  }
  return step.fields;
}

function visibleFieldsAcrossSurvey(answers: Answers): Field[] {
  const cohort = getCohort(answers);
  const out: Field[] = [];
  for (const step of STEPS) {
    const fields = fieldsForStep(step, cohort);
    for (const f of fields) {
      if (isFieldVisible(f, answers)) out.push(f);
    }
  }
  return out;
}

function firstMissingRequired(
  fields: Field[],
  answers: Answers,
  otherTexts: Record<string, string>,
): string | null {
  for (const f of fields) {
    if (!isFieldVisible(f, answers)) continue;
    if (!f.required) continue;
    const v = answers[f.name];

    if (f.kind === 'checkbox' || f.kind === 'rankings') {
      if (!Array.isArray(v) || v.length === 0) {
        return `Please answer "${f.prompt}".`;
      }
    } else {
      if (v === undefined || (typeof v === 'string' && v.trim() === '')) {
        return `Please answer "${f.prompt}".`;
      }
    }

    // Phone-specific: digit count must match the selected country code.
    if (f.kind === 'tel' && typeof v === 'string') {
      const parsed = parsePhone(v);
      const digits = parsed.rest.replace(/\D/g, '');
      const meta = findCountryCode(parsed.code);
      const [min, max] = meta.digits;
      if (digits.length < min || digits.length > max) {
        const len = min === max ? `${max}` : `${min}-${max}`;
        return `Phone number should be ${len} digits for ${meta.country} (${meta.code}).`;
      }
    }

    // Email-specific: surface a shape error immediately on the step that
    // contains the email field, rather than waiting until submit. Mirrors
    // the regex used by validateAllRequired (server has the strict check).
    if (f.kind === 'email' && typeof v === 'string' && v.trim() !== '') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) {
        return 'Please enter a valid email.';
      }
    }

    // "Other" picked but the inline text is blank: not strictly required by
    // the API, but nudge the user.
    const other = pickedOther(f, v);
    const text = otherTexts[f.name]?.trim() ?? '';
    if (other && text === '') {
      return `Please describe your "Other" selection for "${f.prompt}".`;
    }
  }
  return null;
}

function validateAllRequired(answers: Answers): string | null {
  const cohort = getCohort(answers);
  for (const step of STEPS) {
    const missing = firstMissingRequired(fieldsForStep(step, cohort), answers, {});
    if (missing) return missing;
  }
  // basic email shape (server has full validation)
  const email = typeof answers.email === 'string' ? answers.email : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Please enter a valid email.';
  return null;
}

// =============================================================================
// Styles - minimal inline, all reuse design tokens.
// =============================================================================

const srOnlyStyle: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};

// Suppress unused-import warning while keeping the import for type completeness.
void COHORT_LABELS;
