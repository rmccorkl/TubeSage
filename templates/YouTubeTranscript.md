---
title: "<% tp.user.title %>"
video_url: "<% tp.user.watchUrl || tp.user.videoUrl %>"
video_id: "<% tp.user.videoId %>"
thumbnail_url: "<% tp.user.thumbnailUrl %>"
created: <% tp.date.now() %>
tubesage_version: <% tp.user.version %>
tags: <% tp.user.llmTags %>
transcript:  |
<% tp.user.transcript %>
---

<%*
const watchUrl = tp.user.watchUrl || tp.user.videoUrl;
const thumbnailUrl = tp.user.thumbnailUrl || `https://img.youtube.com/vi/${tp.user.videoId}/hqdefault.jpg`;
const fullSummary = tp.user.summary || '';
const headingIndex = fullSummary.search(/^#{1,6}\s/m);
const summaryIntro = headingIndex === -1 ? fullSummary : fullSummary.slice(0, headingIndex);
const summaryBody = headingIndex === -1 ? '' : fullSummary.slice(headingIndex);
const summaryIntroOneLine = summaryIntro.replace(/\s*\n\s*/g, ' ').trim();
-%>

# <% tp.user.title %>
![[Literaturenotes.png|banner+small p+ct]]

> [!tip] Mobile Thumbnail (fallback)
> <%* if (thumbnailUrl && watchUrl) { %>[![YouTube Thumbnail|400x225](<% thumbnailUrl %>)](<% watchUrl %>)<%* } else { %>Thumbnail unavailable for this URL<%* } %>


> [!info] YouTube Video:
> <%* if (watchUrl) { %>![Url|400x200](<% watchUrl %>)<%* } else { %><% tp.user.originalVideoUrl || tp.user.videoUrl %><%* } %>

>[!summary]
>>[!danger] AI :luc_bot: Generated with <% tp.user.llmProvider %>/<% tp.user.llmModel %>
>> <% summaryIntroOneLine %>

<% summaryBody %>

>[!tip] Thoughts while consuming content - As Input to ideas
