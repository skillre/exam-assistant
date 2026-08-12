// FILE: packages/client/src/pages/QuizPage.tsx — MODIFIED (consume full PracticeScope + autoStart)
// ── Changes ──
// 1. initialScope now carries mode+shuffle from task click
// 2. Add autoStart prop for one-click task launch
// 3. start() consumes full scope including shuffle

// ── Modified Props ──
interface Props {
  initialScope?: Partial<PracticeScope> | null;
  autoStart?: boolean; // 新增：一键开练时自动开始
  onNavigateWrong?: () => void;
}

// ── Modified useEffect for initialScope ──
  useEffect(() => {
    if (initialScope?.bankId) setBankId(initialScope.bankId);
    if (initialScope?.mode) setMode(initialScope.mode);
    if (initialScope?.shuffle) setShuffle(initialScope.shuffle);
    if (initialScope?.tag) {
      setTag(initialScope.tag);
      setMode('byTag');
    }
    if (initialScope?.type) {
      setQType(initialScope.type);
      setMode('byType');
    }
  }, [initialScope]);

// ── New useEffect: auto-start when autoStart is true ──
  useEffect(() => {
    if (autoStart && initialScope?.bankId && !session) {
      // Delay slightly to ensure state updates from initialScope effect are applied
      const timer = setTimeout(() => start(), 100);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, initialScope?.bankId]);
