"""Read-only capacity forecast and human-review archive candidates. Never deletes."""
import argparse
import importlib.util
import json
import os
import shutil
import time
from pathlib import Path
spec = importlib.util.spec_from_file_location('backup_sqlite', Path(__file__).with_name('backup-sqlite.py'))
backup = importlib.util.module_from_spec(spec); spec.loader.exec_module(backup)

def status(database, root, interval_seconds=900):
    database, root = database.resolve(strict=True), root.resolve()
    files = backup.managed_files(root)
    databases = [file for file in files if file.suffix.lower() in ('.db','.sqlite','.sqlite3')]
    used = sum(file.stat().st_size for file in files)
    expected = 2 * sum(file.stat().st_size for file in (database,Path(str(database)+'-wal')) if file.exists()) + 1024**2
    actual = max(database.stat().st_size, 1)
    parent = root
    while not parent.exists(): parent = parent.parent
    free = shutil.disk_usage(parent).free
    max_bytes = backup.positive('SQLITE_PRODUCTION_MAX_BYTES',32*1024**3)
    max_copies = backup.positive('SQLITE_PRODUCTION_MAX_COPIES',48)
    min_free = backup.positive('SQLITE_PRODUCTION_MIN_FREE_BYTES',4*1024**3)
    # Every forecast includes one conservative next-generation reservation.
    more = max(0,min(max_copies-len(databases), (max_bytes-used-expected)//actual+1, (free-min_free-expected)//actual+1))
    days = more*interval_seconds/86400
    ready = used+expected <= max_bytes and len(databases)+1 <= max_copies and free-expected >= min_free
    warning = not ready or used/max_bytes >= .5 or len(databases)/max_copies >= .5 or days < 1
    return {'root':str(root),'existingBytes':used,'existingCopies':len(databases),'sourceBytes':actual,'nextReservedBytes':expected,'freeBytes':free,'maxBytes':max_bytes,'maxCopies':max_copies,'minFreeBytes':min_free,'nextBackupAllowed':ready,'continuousChangedSnapshotIntervalSeconds':interval_seconds,'estimatedAdditionalFullSnapshots':more,'estimatedDaysAtContinuousChanges':round(days,2),'warning':warning,'automaticDeletion':False,'action':'Review verified recovery windows and propose a separately approved archive/move plan; do not delete unique recovery points' if warning else 'Review capacity at least daily'}

def archive_candidates(root, min_age_days=7):
    records=[]
    for file in backup.managed_files(root):
        if file.name != 'verification.json': continue
        try:
            receipt=json.loads(file.read_text(encoding='utf-8'))
            database=Path(receipt['backup']).resolve(strict=True)
            if not (database.is_relative_to(root) or any(database.is_relative_to(folder) for folder in backup.legacy_roots())) or not database.is_file(): continue
            records.append((receipt.get('source','unknown'),database.stat().st_mtime,database,receipt.get('sha256')))
        except (OSError,ValueError,KeyError): continue
    newest={}
    for source,mtime,file,digest in records:
        if source not in newest or mtime>newest[source][0]: newest[source]=(mtime,file)
    return [{'backup':str(file),'bytes':file.stat().st_size,'verificationReceiptSha256':digest,'receiptHashRevalidated':False,'action':'human review for verified lossless archival; no deletion authorized'} for source,mtime,file,digest in records if time.time()-mtime>=min_age_days*86400 and newest[source][1]!=file]

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path,required=True)
    parser.add_argument('--backup-root',type=Path)
    parser.add_argument('--interval-seconds',type=int,default=900)
    parser.add_argument('--archive-plan',action='store_true')
    args=parser.parse_args()
    if args.interval_seconds<=0: raise ValueError('Invalid interval')
    root=(args.backup_root or Path(os.environ.get('SQLITE_PRODUCTION_BACKUP_ROOT',args.database.parent/'backups'))).resolve()
    report=status(args.database,root,args.interval_seconds)
    if args.archive_plan: report['reviewCandidates']=archive_candidates(root)
    print(json.dumps(report,ensure_ascii=False,indent=2))
