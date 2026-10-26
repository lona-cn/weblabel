"""No model imports or forwards: Main must run these controls before export."""
import json
import multiprocessing
import os
from pathlib import Path
import tempfile
import shutil
import time
import unittest
from budget import Ledger, BudgetError, meter_model

ROOT = Path(__file__).resolve().parents[2] / 'target' / 'test-artifacts' / 'R05'


def consume(path, queue):
    try:
        queue.put(Ledger(Path(path), 20).charge('synthetic-control')['sequence'])
    except BudgetError:
        queue.put('refused')


class FakeModule:
    def __init__(self): self.hooks=[]
    def register_forward_pre_hook(self, hook):
        self.hooks.append(hook)
        class Handle:
            def remove(inner): self.hooks.remove(hook)
        return Handle()
    def __call__(self, fail=False):
        for hook in self.hooks: hook(self, ())
        if fail: raise RuntimeError('synthetic failure after hook')
        return 7


class Controls(unittest.TestCase):
    def setUp(self):
        ROOT.mkdir(parents=True, exist_ok=True)
        self.temp=Path(tempfile.mkdtemp(dir=ROOT))
        def cleanup():
            result=self._outcome.result
            if any(test is self for test,detail in result.failures+result.errors):
                print('PRESERVED_CONTROL_ARTIFACTS='+str(self.temp))
            else:
                shutil.rmtree(self.temp)
        self.addCleanup(cleanup)
        self.path=self.temp/'ledger.json'
        Ledger.create(self.path,20)

    def test_missing_ledger_and_wrong_limit_fail_closed(self):
        with self.assertRaises(BudgetError): Ledger(self.path.with_name('missing'),20).charge('control')
        with self.assertRaises(BudgetError): Ledger(self.path,21).charge('control')
        self.assertEqual(json.loads(self.path.read_text())['used'],0)

    def test_pre_hook_counts_export_style_implicit_calls_and_failure(self):
        module=FakeModule()
        with meter_model(module,Ledger(self.path,20)):
            self.assertEqual(module(),7)
            with self.assertRaises(RuntimeError): module(fail=True)
        state=json.loads(self.path.read_text())
        self.assertEqual(state['used'],2)
        self.assertEqual([r['sequence'] for r in state['receipts']],[1,2])
        self.assertEqual(module.hooks,[])

    def test_exhaustion_refuses_before_body(self):
        ledger=Ledger(self.path,20)
        for _ in range(20): ledger.charge('control')
        with self.assertRaises(BudgetError): ledger.charge('must-not-run')
        self.assertEqual(json.loads(self.path.read_text())['used'],20)

    def test_cross_process_exclusion_has_no_lost_charges(self):
        queue=multiprocessing.Queue()
        processes=[multiprocessing.Process(target=consume,args=(str(self.path),queue)) for _ in range(24)]
        started=[]
        try:
            for process in processes:
                process.start();started.append(process)
        finally:
            # Always settle ALL started children before any assertion or directory
            # cleanup. A failed early child must not delete later children's lock.
            deadline=time.monotonic()+30
            for process in started: process.join(max(0,deadline-time.monotonic()))
            for process in started:
                if process.is_alive(): process.terminate()
            for process in started: process.join(5)
            for process in started:
                if process.is_alive(): process.kill();process.join(5)
        try:
            self.assertEqual(len(started),24)
            self.assertEqual([process.exitcode for process in started],[0]*24)
            outcomes=[queue.get(timeout=3) for _ in processes]
        finally:
            queue.close();queue.join_thread()
            for process in started: process.close()
        self.assertEqual(sorted(v for v in outcomes if isinstance(v,int)),list(range(1,21)))
        self.assertEqual(outcomes.count('refused'),4)
        self.assertEqual(json.loads(self.path.read_text())['used'],20)

    def test_corrupt_ledger_never_resets_budget(self):
        self.path.write_text('{')
        with self.assertRaises(BudgetError): Ledger(self.path,20).charge('control')
        self.assertEqual(self.path.read_text(),'{')

    def test_real_pinned_legacy_exporter_meters_every_toy_invocation(self):
        # Separate synthetic CONTROL ledger, never the authorized detector ledger.
        # Missing exact dependencies is a hard prerequisite failure, NOT a skip.
        import importlib.metadata
        self.assertEqual(importlib.metadata.version('torch'),'2.14.0')
        self.assertEqual(importlib.metadata.version('onnx'),'1.18.0')
        import torch
        class Toy(torch.nn.Module):
            def __init__(self): super().__init__(); self.invocations=0
            def forward(self,x):
                self.invocations+=1
                return x+1
        toy=Toy().eval()
        ledger=Ledger(self.path,20)
        with meter_model(toy,ledger), torch.inference_mode():
            torch.onnx.export(toy,(torch.zeros((1,3,4,4)),),str(self.path.with_name('CONTROL-toy.onnx')),
                              dynamo=False,opset_version=18,external_data=False)
            state=json.loads(self.path.read_text())
            self.assertGreater(toy.invocations,0)
            self.assertEqual(state['used'],toy.invocations)
            self.assertTrue(all(r['kind']=='python-top-level-forward' for r in state['receipts']))
            for _ in range(20-state['used']): ledger.charge('synthetic-control-fill')
            observed=toy.invocations
            with self.assertRaises(BudgetError):
                torch.onnx.export(toy,(torch.zeros((1,3,4,4)),),str(self.path.with_name('CONTROL-refused.onnx')),
                                  dynamo=False,opset_version=18,external_data=False)
            self.assertEqual(toy.invocations,observed)

    def test_verifier_rejects_real_leaf_symlinks_before_read_hash_or_graph(self):
        # Actual regular-file links, not mocked resolution or invalid-file-type proof.
        # Targets are synthetic siblings inside the project, never private files.
        import hashlib
        from types import SimpleNamespace
        from unittest.mock import patch
        import verify as verifier
        graph=b'synthetic non-model bytes'
        manifest={'model_id':'synthetic-control','source_files':[],
                  'onnx':{'sha256':hashlib.sha256(graph).hexdigest()},
                  'ir_version':11,'opset':18,'goldens':[]}
        for leaf in ('manifest.json','model.onnx'):
            with self.subTest(leaf=leaf):
                directory=self.temp/('export-'+leaf);directory.mkdir()
                target=self.temp/('outside-'+leaf)
                (directory/'manifest.json').write_text(json.dumps(manifest),encoding='utf-8')
                (directory/'model.onnx').write_bytes(graph)
                target.write_bytes((directory/leaf).read_bytes())
                (directory/leaf).unlink()
                try:
                    os.symlink(target,directory/leaf,target_is_directory=False)
                except OSError as error:
                    raise RuntimeError('PREREQUISITE: actual regular-file symlink creation is required; no skip or simulated confinement proof') from error
                self.assertTrue((directory/leaf).is_file())
                self.assertFalse((directory/leaf).resolve().is_relative_to(directory.resolve()))
                args=SimpleNamespace(budget_ledger=self.path,max_forwards=20,weights_dir=self.temp,
                                     model_dir=directory,weblabel_binary=self.temp/'weblabel.exe',
                                     report_dir=self.temp/'never-created')
                with patch.object(verifier,'offline'),patch.object(verifier,'identity',return_value={}), \
                     patch.object(verifier,'weights',return_value=(self.temp,{'model_id':'synthetic-control','files':[]})), \
                     patch.object(verifier,'graph',side_effect=AssertionError('escaped artifact reached graph parser')) as parse, \
                     patch.object(verifier,'load_model',side_effect=AssertionError('model load forbidden')) as load, \
                     patch.object(verifier,'digest',wraps=verifier.digest) as hashes:
                    with self.assertRaisesRegex(RuntimeError,'model artifact path escape'):
                        verifier.run(args)
                    parse.assert_not_called();load.assert_not_called();hashes.assert_not_called()
                self.assertEqual(json.loads(self.path.read_text())['used'],0)

    def test_verifier_preflights_all_runtime_files_without_native_loading(self):
        import hashlib
        from unittest.mock import patch
        import verify as verifier
        # Synthetic regular files exercise the production metadata-driven preflight;
        # these are not native libraries and the test never invokes a loader.
        runtime=self.temp/'runtime';(runtime/'lib').mkdir(parents=True)
        entries={}
        for name,path in [('library','lib/onnxruntime.dll'),('shared_library','lib/onnxruntime_providers_shared.dll'),
                          ('license','LICENSE'),('third_party_notices','ThirdPartyNotices.txt')]:
            content=('synthetic-'+name).encode();(runtime/path).write_bytes(content)
            entries[name]={'path':path,'bytes':len(content),'sha256':hashlib.sha256(content).hexdigest()}
        metadata=self.temp/'runtime-lock.json'
        metadata.write_text(json.dumps({'runtime':entries}),encoding='utf-8')
        shared=runtime/entries['shared_library']['path'];original=shared.read_bytes()
        with patch.object(verifier,'SOURCE',self.temp/'source-lock.json'), \
             patch.object(verifier,'RUNTIME',runtime/entries['library']['path']), \
             patch.object(verifier,'RUNTIME_SHA',entries['library']['sha256']):
            verifier.preflight_runtime()
            shared.unlink()
            with self.assertRaisesRegex(RuntimeError,'runtime dependency'):
                verifier.preflight_runtime()
            shared.write_bytes(original+b'changed')
            with self.assertRaisesRegex(RuntimeError,'runtime dependency'):
                verifier.preflight_runtime()
            shared.write_bytes(original)
            (runtime/'LICENSE').write_bytes(b'changed license')
            with self.assertRaisesRegex(RuntimeError,'runtime dependency'):
                verifier.preflight_runtime()
        self.assertEqual(json.loads(self.path.read_text())['used'],0)


if __name__=='__main__': unittest.main()
