// FILE: packages/client/src/pages/QuizPage.tsx — MODIFIED (finish function)
// ── Change the finish() function ──

  async function finish() {
    if (!session) return;
    try {
      const resp = await api.finishPractice(session.id);
      setScorecard(resp.scorecard);
    } catch (e) {
      setError((e as Error).message);
    }
  }
