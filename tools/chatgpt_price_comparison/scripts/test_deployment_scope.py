import subprocess
import tempfile
import unittest
from pathlib import Path
import deployment_scope
class DeploymentScopeTests(unittest.TestCase):
    def git(self,cwd,*args):
        return subprocess.run(['git',*args],cwd=cwd,capture_output=True,text=True,check=True).stdout.strip()
    def commit_file(self,repo,relative,content,message):
        path = repo/relative
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(content,encoding='utf-8')
        self.git(repo,'add',relative)
        self.git(repo,'commit','-m',message)
        return self.git(repo,'rev-parse','HEAD')
    def test_unrelated_successor_with_missing_intermediate_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            origin = root/'origin'
            origin.mkdir()
            self.git(origin,'init','-b','main')
            self.git(origin,'config','user.name','Fixture')
            self.git(origin,'config','user.email','fixture@example.invalid')
            self.commit_file(origin,'tools/chatgpt_price_comparison/data/prices.json','baseline','A')
            published = self.commit_file(origin,'tools/chatgpt_price_comparison/data/prices.json','published','B')
            unrelated = self.commit_file(origin,'unrelated.txt','other','C')
            checkout = root/'checkout'
            self.git(root,'clone','--depth=1',origin.as_uri(),str(checkout))
            with self.assertRaises(RuntimeError): deployment_scope.compare_project(published,unrelated,checkout)
            self.git(checkout,'fetch','origin',published,'--depth=1')
            self.assertEqual(deployment_scope.compare_project(published,unrelated,checkout),0)
            changed = self.commit_file(origin,'tools/chatgpt_price_comparison/app.js','changed','D')
            self.git(checkout,'fetch','origin',changed,'--depth=1')
            self.assertEqual(deployment_scope.compare_project(published,changed,checkout),1)
    def test_unknown_commit_and_non_sha_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            self.git(repo,'init','-b','main')
            with self.assertRaises(RuntimeError): deployment_scope.compare_project('a'*40,'b'*40,repo)
            with self.assertRaises(ValueError): deployment_scope.compare_project('main','b'*40,repo)
if __name__ == '__main__': unittest.main()
