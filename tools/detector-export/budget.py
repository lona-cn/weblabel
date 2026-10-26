"""Development-only shared forward budget. No model packages imported here."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
import uuid


class BudgetError(RuntimeError): pass


@contextmanager
def exclusive(path):
    sidecar=Path(str(path)+'.lock')
    with sidecar.open('a+b') as handle:
        if handle.seek(0,2)==0:
            handle.write(b'\0'); handle.flush(); os.fsync(handle.fileno())
        handle.seek(0)
        if os.name=='nt':
            import msvcrt
            while True:
                try: msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1); break
                except OSError: time.sleep(.01)
        else:
            import fcntl
            fcntl.flock(handle,fcntl.LOCK_EX)
        try: yield
        finally:
            handle.seek(0)
            if os.name=='nt': msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
            else: fcntl.flock(handle,fcntl.LOCK_UN)


def persist(path,state):
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    try:
        with temporary.open('x',encoding='utf-8',newline='\n') as handle:
            json.dump(state,handle,ensure_ascii=False,allow_nan=False,separators=(',',':'))
            handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
        os.replace(temporary,path)
        if os.name!='nt':
            fd=os.open(path.parent,os.O_RDONLY)
            try: os.fsync(fd)
            finally: os.close(fd)
    finally:
        temporary.unlink(missing_ok=True)


class Ledger:
    def __init__(self,path,limit):
        # Resolve only the immutable parent here. CPython3.12 Windows realpath
        # opens an existing leaf with shareMode=0; doing that outside the sidecar
        # lock races another writer's atomic replacement with WinError5.
        candidate=Path(os.path.abspath(path))
        self.path=candidate.parent.resolve()/candidate.name
        if limit!=20: raise BudgetError('authorized forward limit is exactly 20')
        self.limit=limit

    @staticmethod
    def create(path,limit):
        ledger=Ledger(path,limit)
        if not ledger.path.parent.is_dir(): raise BudgetError('ledger parent must already exist')
        with exclusive(ledger.path):
            if ledger.path.exists(): raise BudgetError('refusing to replace an existing ledger')
            persist(ledger.path,{'schema_version':1,'limit':20,'used':0,'receipts':[]})
        return ledger

    def _load(self):
        try:
            # All leaf resolution/reads are inside exclusive(). Reject aliases so
            # two differently named sidecars cannot govern one ledger target.
            if self.path.resolve(strict=True)!=self.path:
                raise ValueError('redirected ledger leaf prohibited')
            state=json.loads(self.path.read_text(encoding='utf-8'))
            used=state['used']; receipts=state['receipts']
            if state['schema_version']!=1 or state['limit']!=20 or type(used)!=int or not 0<=used<=20 or len(receipts)!=used:
                raise ValueError('invalid accounting')
            if [r['sequence'] for r in receipts]!=list(range(1,used+1)): raise ValueError('invalid receipts')
            return state
        except (OSError,ValueError,KeyError,TypeError) as error:
            raise BudgetError('missing/corrupt ledger; never reset automatically') from error

    def ensure_available(self,minimum=1):
        with exclusive(self.path):
            state=self._load()
            if 20-state['used']<minimum: raise BudgetError('insufficient remaining forward budget')
            return state

    def charge(self,kind):
        if not isinstance(kind,str) or not kind or len(kind)>128: raise BudgetError('invalid charge kind')
        with exclusive(self.path):
            state=self._load()
            if state['used']>=20: raise BudgetError('forward budget exhausted')
            receipt={'sequence':state['used']+1,'kind':kind,'nonce':uuid.uuid4().hex,'pid':os.getpid(),'at':datetime.now(timezone.utc).isoformat(),'redeemed':False}
            state['used']+=1; state['receipts'].append(receipt)
            persist(self.path,state)
            return dict(receipt)


@contextmanager
def meter_model(model,ledger):
    # Top-level model __call__ hooks also execute for legacy-export implicit traces.
    # Direct model.forward calls are forbidden in these tools.
    def pre_forward(module,args):
        ledger.charge('python-top-level-forward')
        return None  # Torch treats any non-None return as replacement arguments.
    handle=model.register_forward_pre_hook(pre_forward)
    try: yield
    finally: handle.remove()


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description='Create a NEW development ledger; never reset one.')
    parser.add_argument('--create',type=Path,required=True)
    parser.add_argument('--max-forwards',type=int,required=True)
    args=parser.parse_args()
    Ledger.create(args.create,args.max_forwards)
