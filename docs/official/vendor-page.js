(function () {
  "use strict";

  const status = document.getElementById("copyStatus");
  let statusTimer;

  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-copy-target], [data-copy-value]");
    if (!button) return;

    const target = button.dataset.copyTarget
      ? document.getElementById(button.dataset.copyTarget)
      : null;
    const value = button.dataset.copyValue || target?.textContent.trim();
    copyText(value, button, button.dataset.copyMessage);
  });

  setupVendorSearch();

  async function copyText(value, button, message) {
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }

    document.querySelectorAll(".copy-button.copied").forEach((item) => {
      if (item !== button) item.classList.remove("copied");
    });
    button.classList.add("copied");

    if (status) {
      status.textContent = message || "Copied";
      status.classList.add("visible");
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => status.classList.remove("visible"), 1800);
    }

    setTimeout(() => button.classList.remove("copied"), 1800);
  }

  function setupVendorSearch() {
    const input = document.getElementById("skillSearch");
    const groups = document.getElementById("skillGroups");
    const resultCount = document.getElementById("skillsResultCount");
    const emptyState = document.getElementById("skillsEmpty");
    const pagination = document.querySelector(".vendor-pagination");

    if (!input || !groups || !groups.dataset.vendorDataUrl) return;

    const originalMarkup = groups.innerHTML;
    const originalResultLabel = resultCount?.textContent || "";
    let vendorDataPromise;
    let requestId = 0;

    input.addEventListener("input", () => {
      const query = input.value.trim().toLowerCase();
      requestId += 1;
      const currentRequest = requestId;

      if (!query) {
        groups.innerHTML = originalMarkup;
        if (resultCount) resultCount.textContent = originalResultLabel;
        if (emptyState) {
          emptyState.hidden = true;
          emptyState.textContent = "No skills match this search.";
        }
        if (pagination) pagination.hidden = false;
        return;
      }

      if (resultCount) resultCount.textContent = "Searching...";
      if (pagination) pagination.hidden = true;

      vendorDataPromise ||= fetch(groups.dataset.vendorDataUrl, {
        cache: "no-store"
      }).then((response) => {
        if (!response.ok) {
          throw new Error(`Vendor search request failed with ${response.status}`);
        }
        return response.json();
      });

      vendorDataPromise
        .then((data) => {
          if (currentRequest !== requestId) return;
          renderSearchResults({
            data,
            query,
            groups,
            resultCount,
            emptyState,
            campaign: groups.dataset.searchCampaign
          });
        })
        .catch(() => {
          if (currentRequest !== requestId) return;
          groups.innerHTML = originalMarkup;
          if (resultCount) resultCount.textContent = originalResultLabel;
          if (emptyState) {
            emptyState.hidden = false;
            emptyState.textContent =
              "Search is temporarily unavailable. Browse the paginated skills below.";
          }
          if (pagination) pagination.hidden = false;
        });
    });
  }

  function renderSearchResults({
    data,
    query,
    groups,
    resultCount,
    emptyState,
    campaign
  }) {
    const terms = query.split(/\s+/).filter(Boolean);
    const matches = (data.skills || []).filter((skill) => {
      const text = [
        skill.displayName,
        skill.skillName,
        skill.description,
        skill.installRepo
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return terms.every((term) => text.includes(term));
    });
    const visibleMatches = matches.slice(0, 100);
    const matchesByRepo = new Map();

    for (const skill of visibleMatches) {
      const repoSkills = matchesByRepo.get(skill.installRepo) || [];
      repoSkills.push(skill);
      matchesByRepo.set(skill.installRepo, repoSkills);
    }

    groups.replaceChildren(
      ...[...matchesByRepo.entries()].map(([repo, skills]) =>
        createSkillGroup(repo, skills, campaign)
      )
    );

    if (resultCount) {
      resultCount.textContent =
        matches.length > visibleMatches.length
          ? `Showing ${visibleMatches.length.toLocaleString("en-US")} of ${matches.length.toLocaleString("en-US")} matches`
          : `${matches.length.toLocaleString("en-US")} ${
              matches.length === 1 ? "match" : "matches"
            }`;
    }
    if (emptyState) emptyState.hidden = matches.length > 0;
  }

  function createSkillGroup(repo, skills, campaign) {
    const details = document.createElement("details");
    details.className = "skill-group";
    details.open = true;
    details.dataset.skillGroup = "";

    const summary = document.createElement("summary");
    const label = document.createElement("span");
    const name = document.createElement("strong");
    const count = document.createElement("small");
    name.textContent = repo;
    count.textContent = `${skills.length.toLocaleString("en-US")} ${
      skills.length === 1 ? "skill" : "skills"
    }`;
    label.append(name, count);
    summary.append(label, createChevronIcon());

    const list = document.createElement("div");
    list.className = "skills-list";
    list.append(
      ...skills.map((skill) => createSkillCard(skill, campaign))
    );
    details.append(summary, list);
    return details;
  }

  function createSkillCard(skill, campaign) {
    const card = document.createElement("article");
    card.className = "skill-card";
    card.dataset.skillCard = "";

    const content = document.createElement("div");
    const name = document.createElement("h3");
    name.className = "skill-name";
    name.textContent = skill.displayName || skill.skillName;
    content.append(name);

    if (skill.description) {
      const description = document.createElement("p");
      description.className = "skill-description";
      description.textContent = skill.description;
      content.append(description);
    }

    const meta = document.createElement("div");
    meta.className = "skill-meta";
    const repo = document.createElement("span");
    const installs = document.createElement("span");
    repo.textContent = skill.installRepo;
    installs.textContent = `${Number(skill.installsCount || 0).toLocaleString(
      "en-US"
    )} installs`;
    meta.append(repo, installs);
    content.append(meta);

    const actions = document.createElement("div");
    actions.className = "skill-actions";
    const source = document.createElement("a");
    source.className = "skill-link";
    source.href = addUtm(skill.sourceUrl, campaign);
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.append(createExternalIcon(), "View source");

    const copy = document.createElement("button");
    copy.className = "skill-copy";
    copy.type = "button";
    copy.dataset.copyValue = `npx skills add ${skill.installRepo}@${skill.skillName} -y`;
    copy.dataset.copyMessage = "Skill command copied";
    copy.append(createCopyIcon(), "Copy install");
    actions.append(source, copy);

    card.append(content, actions);
    return card;
  }

  function createChevronIcon() {
    const icon = createSvg("0 0 16 16");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.8");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "m4 6 4 4 4-4");
    icon.append(path);
    return icon;
  }

  function createExternalIcon() {
    const icon = createSvg("0 0 20 20");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.7");
    const first = document.createElementNS("http://www.w3.org/2000/svg", "path");
    first.setAttribute(
      "d",
      "M7 4H4.8A1.8 1.8 0 0 0 3 5.8v9.4A1.8 1.8 0 0 0 4.8 17h9.4a1.8 1.8 0 0 0 1.8-1.8V13"
    );
    const second = document.createElementNS("http://www.w3.org/2000/svg", "path");
    second.setAttribute("d", "M11 3h6v6M9 11l8-8");
    icon.append(first, second);
    return icon;
  }

  function createCopyIcon() {
    const icon = createSvg("0 0 20 20");
    icon.setAttribute("fill", "none");
    icon.setAttribute("stroke", "currentColor");
    icon.setAttribute("stroke-width", "1.7");
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", "6.5");
    rect.setAttribute("y", "6.5");
    rect.setAttribute("width", "9");
    rect.setAttribute("height", "9");
    rect.setAttribute("rx", "1.8");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute(
      "d",
      "M4 13.5H3.8A1.8 1.8 0 0 1 2 11.7V3.8A1.8 1.8 0 0 1 3.8 2h7.9a1.8 1.8 0 0 1 1.8 1.8V4"
    );
    icon.append(rect, path);
    return icon;
  }

  function createSvg(viewBox) {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", viewBox);
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  function addUtm(value, campaign) {
    try {
      const url = new URL(value);
      url.searchParams.set("utm_source", "skillscout");
      url.searchParams.set("utm_medium", "vendor_page");
      url.searchParams.set("utm_campaign", campaign || "official_vendor");
      return url.toString();
    } catch {
      return value;
    }
  }
})();
