import argparse
import re
import subprocess
import sys
PATHS = ('tools/chatgpt_price_comparison', '.github/workflows/*chatgpt*.yml')
def compare_project(base, head, cwd=None):
    if not all(isinstance(ref,str) and re.fullmatch(r'[a-f0-9]{40}',ref) for ref in (base,head)):
        raise ValueError('expected exact 40-character commit SHAs')
    for ref in (base,head):
        result = subprocess.run(['git','cat-file','-e',ref+'^{commit}'],cwd=cwd,capture_output=True,text=True)
        if result.returncode != 0: raise RuntimeError('required comparison commit is unavailable: '+ref)
    result = subprocess.run(['git','diff','--quiet',base,head,'--',*PATHS],cwd=cwd,capture_output=True,text=True)
    if result.returncode not in (0,1): raise RuntimeError('git diff failed: '+result.stderr.strip()[:400])
    return result.returncode
def main():
    parser = argparse.ArgumentParser(description='Exit 0 unchanged; 1 changed; 2 comparison failed')
    parser.add_argument('--base',required=True)
    parser.add_argument('--head',required=True)
    args = parser.parse_args()
    try: return compare_project(args.base,args.head)
    except (ValueError,RuntimeError,OSError) as error:
        print(str(error),file=sys.stderr)
        return 2
if __name__ == '__main__': sys.exit(main())
