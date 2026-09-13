export function entryHtml(title = "Fictional Film Residency", url = "https://example.org/residency", deadline = "November 3, 2026") {
  return `<div class="opportunity-guide-entry"><div class="row">
    <div><p class="opportunity-date">${deadline}<span class="days-left">56 days left</span></p>
      <h2 class="bold">${title}<div class="label rounded secondary">Residency</div></h2></div>
    <div><ul class="opportunity-info-list">
      <li><span>Organization:</span> Fictional Arts</li>
      <li><span>Submission Deadline:</span> ${deadline}</li>
      <li><span>Entry Fee:</span> $40</li>
      <li><span>Award Info:</span> $600 stipend</li>
      <li><span>Eligibility:</span> National</li>
      <li><span>Categories:</span> Film/Video/New Media</li>
      <li><span>Location:</span> Colorado</li></ul></div>
    <div><fieldset><legend>Description</legend></fieldset>
      <section class="external_link_security"><p>Submit a film for selection.</p><p>Housing and studio included.</p></section>
      <fieldset><legend>Eligibility Info</legend><p>Open to US and Canadian residents aged 18 or older.</p></fieldset></div>
    <div class="external-opportunity-links"><a href="${url}">Apply</a><a href="${url}">Learn More</a>
      <a class="js-opportunity-add-to-schedule" href="#">Add To Schedule</a></div>
    </div></div>`;
}
export function guideHtml(entries = entryHtml()) {
  return `<html><body><nav><a href="https://example.org/promo">Join now</a></nav>
    <h1 id="guide-anchor">Guide to the Best Artist Grants and Opportunities in the Western U.S.</h1>
    <select name="opportunity_category_filter[]"><option value="3">Photography</option>
      <option value="5" selected="selected">Film/Video/New Media</option></select>
    <h2>MORE COMING SOON: Our team is currently hard at work searching for opportunities in this region!</h2>
    ${entries}<footer>Get a free trial</footer></body></html>`;
}
