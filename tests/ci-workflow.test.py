import unittest,pathlib,yaml
ROOT=pathlib.Path(__file__).resolve().parents[1]
class WorkflowContract(unittest.TestCase):
 def test_private_guard_and_two_build_runners(self):
  w=yaml.safe_load((ROOT/'.github/workflows/ci.yml').read_text())
  self.assertEqual(set(w['jobs']),{'verify','publish'})
  self.assertEqual(w['jobs']['verify']['strategy']['matrix']['os'],['ubuntu-24.04','windows-2025'])
  for job in w['jobs'].values():self.assertIn('github.event.repository.private == false',job['if'])
 def test_browser_and_all_supported_codex_versions(self):
  s=(ROOT/'.github/workflows/ci.yml').read_text()
  self.assertIn('SUPPORTED_CODEX_VERSIONS',s)
  self.assertIn('ready_for_review',s)
  self.assertIn('node --test tests/ci-contract.test.mjs',s)
 def test_no_privileged_pr_or_cache(self):
  s=(ROOT/'.github/workflows/ci.yml').read_text();self.assertNotIn('pull_request_target',s)
  w=yaml.safe_load(s)
  self.assertEqual(w['jobs']['verify'].get('permissions',w['permissions']),{'contents':'read','actions':'read'})
  self.assertEqual(w['jobs']['publish']['needs'],'verify')
  self.assertIn("github.ref == 'refs/heads/main'",w['jobs']['publish']['if'])
  self.assertIn('retention-days: 1',s);self.assertNotIn('cache: npm',s)
if __name__=='__main__':unittest.main()
