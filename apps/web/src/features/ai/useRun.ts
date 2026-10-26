import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRunController, type RunController, type RunControllerOptions, type RunSnapshot } from './run-controller';

export function useRun(options: RunControllerOptions) {
  const latest = useRef(options);
  latest.current = options;
  const controller = useRef<RunController | null>(null);
  const [snapshot, setSnapshot] = useState<Readonly<RunSnapshot>>({ runId: null, runScope: null, events: [], candidates: [], error: null, busy: false, modelWaiting: false, savedMessage: null });
  useEffect(() => {
    const owned = createRunController(latest.current);
    controller.current = owned;
    const unsubscribe = owned.subscribe(() => setSnapshot(owned.getSnapshot()));
    setSnapshot(owned.getSnapshot());
    return () => {
      unsubscribe(); owned.dispose();
      if (controller.current === owned) controller.current = null;
    };
  }, []);
  useLayoutEffect(() => { controller.current?.update(options); });
  const actions = useMemo(() => {
    const active = () => {
      if (!controller.current) throw new Error('AI controller is not mounted');
      return controller.current;
    };
    return {
      run: ((preview) => active().run(preview)) satisfies RunController['run'],
      preparePreview: () => active().preparePreview(),
      getPreviewSnapshot: (previewId: string) => active().getPreviewSnapshot(previewId),
      cancel: () => active().cancel(),
      acceptSelected: ((...args) => active().acceptSelected(...args)) satisfies RunController['acceptSelected'],
    };
  }, []);
  return { ...snapshot, ...actions };
}
