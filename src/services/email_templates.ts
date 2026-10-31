export type EmailTemplateContent = { subject: string; body: string };
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function appUrl() { return (process.env.FRONTEND_URL || 'https://clad.style').replace(/\/$/, ''); }
function frame(preheader: string, eyebrow: string, title: string, content: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clad Atelier</title></head>
<body style="margin:0;padding:0;background:#f5f4ef;color:#252622;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff"><tr><td style="padding:36px 28px">
<a href="${appUrl()}/app" style="text-decoration:none;color:#252622;font:32px Georgia,serif">Clad <em style="color:#bf694b">Atelier</em></a>
<p style="margin:42px 0 12px;font-size:10px;letter-spacing:2px;color:#8c8b83">${eyebrow}</p>
<h1 style="margin:0 0 24px;font-size:32px;line-height:1.2;font-weight:400;letter-spacing:-1px">${title}</h1>
<div style="font-size:15px;line-height:1.7;color:#66675f">${content}</div>
<p style="margin:42px 0 0;padding-top:24px;border-top:1px solid #e9e7df;font-size:12px;color:#97978d">Less deciding. More living.<br>Clad Atelier</p>
</td></tr></table></td></tr></table></body></html>`;
}
function link(href: string, title: string) { return `<p style="margin:30px 0 0"><a href="${href}" style="color:#a95538;font-size:15px;text-decoration:underline;text-underline-offset:4px">${title} &rarr;</a></p>`; }
export function defaultEmailTemplates(): Record<string, EmailTemplateContent> {
 return {
  welcome: {subject:'Welcome to Clad Atelier',body:frame('Good outfits start with what you already own.','A LITTLE MORE YOU','Welcome, {{userName}}.',`<p>Good outfits start with what you already own. Let’s give your wardrobe a fresh perspective.</p><p>Start with a few favorites: a top, a pair of trousers, and your go-to shoes. Clad will help you discover ways to wear them together.</p>${link(`${appUrl()}/app/closet/add`,'Add your first pieces')}`)},
  trip_digest: {subject:'Your {{destination}} wardrobe is ready',body:frame('Your itinerary and packing list, together in one place.','YOUR NEXT CHAPTER','A few days in {{destination}}.',`<p style="color:#9a6a55">{{dateRange}}</p><p>Your outfits and packing list are ready. You can adjust the clothes, luggage, and plans whenever you need to.</p><h2 style="font-size:19px;font-weight:400;color:#252622;margin-top:32px">A little less to carry.</h2>{{packingListHtml}}<h2 style="font-size:19px;font-weight:400;color:#252622;margin-top:32px">A look for each day.</h2>{{itineraryHtml}}${link('{{tripUrl}}','Open your journey')}`)},
  neglected_digest: {subject:'A fresh look at your closet',body:frame('Rediscover a few pieces you haven’t worn lately.','ALREADY YOURS','Some favorites deserve another outing.',`<p>A few pieces haven’t been worn recently. This could be the perfect time to bring them back into rotation.</p>{{neglectedItemsHtml}}${link(`${appUrl()}/app/closet`,'Rediscover your closet')}`)},
 };
}
export function resolveEmailTemplate(id: string, stored?: EmailTemplateContent | null): EmailTemplateContent {
 const defaults=defaultEmailTemplates()[id];
 const legacy=stored && /CLAD ATELIER \/\/ (Travel Blueprint|ONBOARDING Blueprints|NEGLECT ALERTS)/.test(stored.body);
 return !stored || legacy ? defaults : stored;
}
export function passwordResetEmail(resetUrl: string) {
 return { subject:'Reset your Clad password', html:frame('Your password reset link is valid for one hour.','YOUR ACCOUNT','A fresh start.',`<p>We received a request to reset your Clad password.</p><p>This link expires in one hour. If you didn’t request it, you can ignore this email; your password will stay the same.</p>${link(escapeHtml(resetUrl),'Reset your password')}`) };
}
export function packingEmailHtml(ids: string[], wardrobe: {id:string;name:string;category:string}[]) {
 const items=new Map(wardrobe.map(p=>[p.id,p]));
 return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${ids.map(id=>items.get(id)).filter(Boolean).map(p=>`<tr><td style="padding:12px 0;border-bottom:1px solid #efede6;font-size:14px;color:#34352f">${escapeHtml(p!.name)}</td><td style="padding:12px 0 12px 12px;border-bottom:1px solid #efede6;text-align:right;font-size:12px;color:#929388">${escapeHtml(p!.category)}</td></tr>`).join('')}</table>`;
}
export function itineraryEmailHtml(days: {day:number;outfit:{name?:string;itemIds:string[];rationale?:string}}[],wardrobe:{id:string;name:string}[]) {
 const items=new Map(wardrobe.map(p=>[p.id,p.name]));
 return days.map(d=>`<div style="margin:20px 0;padding:0 0 20px;border-bottom:1px solid #efede6"><p style="font-size:11px;color:#b86b4f;margin:0 0 6px">DAY ${escapeHtml(d.day)}</p><h3 style="font-size:17px;font-weight:400;color:#34352f;margin:0 0 8px">${escapeHtml(d.outfit.name||'Your look')}</h3><p style="margin:0;font-size:13px">${d.outfit.itemIds.map(id=>items.get(id)).filter(Boolean).map(escapeHtml).join(' · ')}</p></div>`).join('');
}
