import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultEmailTemplates,resolveEmailTemplate,packingEmailHtml,itineraryEmailHtml,passwordResetEmail} from '../src/services/email_templates';
import {EmailService} from '../src/services/email_service';
test('new brand templates replace old seeded emails without overwriting custom copy',()=>{
 const old={subject:'Old',body:'CLAD ATELIER // Travel Blueprint #060097'};
 assert.equal(resolveEmailTemplate('trip_digest',old).subject,'Your {{destination}} wardrobe is ready');
 const custom={subject:'Our custom greeting',body:'<p>Team-written copy</p>'};
 assert.deepEqual(resolveEmailTemplate('welcome',custom),custom);
 assert.match(defaultEmailTemplates().welcome.body,/\/app\/closet\/add/);
 assert.doesNotMatch(defaultEmailTemplates().welcome.body,/#060097|calibration|clad-atelier.com/);
});
test('garment names are escaped and replacement text stays literal',()=>{
 const wardrobe=[{id:'a',name:'<img src=x onerror=alert(1)>',category:'top'}];
 assert.doesNotMatch(packingEmailHtml(['a'],wardrobe),/<img/);
 assert.match(itineraryEmailHtml([{day:1,outfit:{name:'<script>',itemIds:['a']}}],wardrobe),/&lt;script&gt;/);
 assert.equal(EmailService.interpolate('{{destination}}',{destination:'Cost $& savings'}),'Cost $& savings');
 const reset=passwordResetEmail('https://clad.style/reset-password?token=test-only');
 assert.match(reset.html,/expires in one hour/);assert.doesNotMatch(reset.html,/calibration|#060097/);
});
