import * as core from '@actions/core'
import * as github from '@actions/github'

// TODO: Ensure this (and the Octokit client) works for non-github.com URLs, as well.
// https://github.com/orgs|users/<ownerName>/projects/<projectNumber>
const urlParse =
  /^(?:https:\/\/)?github\.com\/(?<ownerType>orgs|users)\/(?<ownerName>[^/]+)\/projects\/(?<projectNumber>\d+)/

interface ProjectNodeIDResponse {
  organization?: {
    projectV2: {
      id: string
    }
  }

  user?: {
    projectV2: {
      id: string
    }
  }
}

interface ProjectAddItemResponse {
  addProjectV2ItemById: {
    item: {
      id: string
    }
  }
}

interface ProjectV2AddDraftIssueResponse {
  addProjectV2DraftIssue: {
    projectItem: {
      id: string
    }
  }
}

export async function addToProject(): Promise<void> {
  const projectUrl = core.getInput('project-url', {required: true})
  const ghToken = core.getInput('github-token', {required: true})
  const labeled =
    core
      .getInput('labeled')
      .split(',')
      .map(l => l.trim().toLowerCase())
      .filter(l => l.length > 0) ?? []
  const labelOperator = core.getInput('label-operator').trim().toLocaleLowerCase()
  const milestoned =
    core
      .getInput('milestoned')
      .split(',')
      .map(l => l.trim())
      .filter(l => l.length > 0) ?? []
  const removeUnmatched = core.getInput('remove-unmatched')
  const fuzzyMatch = core.getInput('fuzzy-match')
  core.debug(`fuzzy-match: ${fuzzyMatch}`)

  const octokit = github.getOctokit(ghToken)

  const issue = github.context.payload.issue ?? github.context.payload.pull_request
  const issueLabels: string[] = (issue?.labels ?? []).map((l: {name: string}) => l.name.toLowerCase())
  const issueMilestone: string = issue?.milestone?.title
  const issueOwnerName = github.context.payload.repository?.owner.login
  let shouldRemove = false
  let shouldFuzzyMatch = false

  core.debug(`Issue/PR owner: ${issueOwnerName}`)

  // Ensure the issue matches our `labeled` filter based on the label-operator.
  if (labelOperator === 'and') {
    if (!labeled.every(l => issueLabels.includes(l))) {
      core.info(`Skipping issue ${issue?.number} because it doesn't match all the labels: ${labeled.join(', ')}`)
      return
    }
  } else if (labelOperator === 'not') {
    if (labeled.length > 0 && issueLabels.some(l => labeled.includes(l))) {
      core.info(`Skipping issue ${issue?.number} because it contains one of the labels: ${labeled.join(', ')}`)
      return
    }
  } else {
    if (labeled.length > 0 && !issueLabels.some(l => labeled.includes(l))) {
      core.info(`Skipping issue ${issue?.number} because it does not have one of the labels: ${labeled.join(', ')}`)
      return
    }
  }

  if ( fuzzyMatch === 'true' || fuzzyMatch === 'True' ) {
    shouldFuzzyMatch = true;
    core.info("Using fuzzy matching for milestones");
  }

  function milestoneEnabled(milestone: string) {
    if ( !shouldFuzzyMatch ) return milestoned.includes(milestone);
    return milestoned.some(m => milestone.startsWith(m));
  }

  // Ensure the issue matches our `milestoned` filter, which is always "OR"
  if (milestoned.length > 0 && !milestoneEnabled(issueMilestone)) {
    if (removeUnmatched === 'true' || removeUnmatched === 'True') {
      core.info(`Removing issue ${issue?.number} because ${issueMilestone} is not one of the milestones: ${milestoned.join(', ')}`)
      shouldRemove = true
    } else {
      core.info(`Skipping issue ${issue?.number} because ${issueMilestone} is not one of the milestones: ${milestoned.join(', ')}`)
      return
    }
  }

  core.debug(`Project URL: ${projectUrl}`)

  const urlMatch = projectUrl.match(urlParse)

  if (!urlMatch) {
    throw new Error(
      `Invalid project URL: ${projectUrl}. Project URL should match the format https://github.com/<orgs-or-users>/<ownerName>/projects/<projectNumber>`
    )
  }

  const projectOwnerName = urlMatch.groups?.ownerName
  const projectNumber = parseInt(urlMatch.groups?.projectNumber ?? '', 10)
  const ownerType = urlMatch.groups?.ownerType
  const ownerTypeQuery = mustGetOwnerTypeQuery(ownerType)

  core.debug(`Project owner: ${projectOwnerName}`)
  core.debug(`Project number: ${projectNumber}`)
  core.debug(`Project owner type: ${ownerType}`)

  // First, use the GraphQL API to request the project's node ID.
  const idResp = await octokit.graphql<ProjectNodeIDResponse>(
    `query getProject($projectOwnerName: String!, $projectNumber: Int!) {
      ${ownerTypeQuery}(login: $projectOwnerName) {
        projectV2(number: $projectNumber) {
          id
        }
      }
    }`,
    {
      projectOwnerName,
      projectNumber
    }
  )

  const projectId = idResp[ownerTypeQuery]?.projectV2.id
  const contentId = issue?.node_id

  core.debug(`Project node ID: ${projectId}`)
  core.debug(`Content ID: ${contentId}`)

  if (shouldRemove && issue) {
    let item = null
    let hasNextPage = true
    let cursor = null

    while (!item && hasNextPage) {
      // Find the project item if it exists
      const response: ProjectNextItemResponse = await octokit.graphql<ProjectNextItemResponse>(
        `
        query projectIssues($org: String!, $number: Int!, $after: String) {
          organization(login: $org) {
            projectNext(number: $number) {
              items(first: 100, after: $after) {
                pageInfo {
                  startCursor
                  endCursor
                  hasNextPage
                }
                totalCount
                nodes {
                  id
                  content {
                    ... on Issue {
                      id
                    }
                  }
                }
              }
            }
          }
        }
        `,
        {
          org: ownerName,
          number: projectNumber,
          after: cursor
        }
      )
      if (!response.organization) return
      item = response.organization.projectNext.items.nodes.find((n: ProjectNextItem) => n.content.id === issue.node_id)
      hasNextPage = response.organization.projectNext.items.pageInfo.hasNextPage
      cursor = response.organization.projectNext.items.pageInfo.endCursor
    }

    if (!item) {
      core.warning(`Could not find Project Item linked to Issue ${issue.node_id}`)
      return
    }

    // Remove Item from Project
    const deletedItemId = await octokit.graphql<ProjectAddItemResponse>(
      `mutation removeIssueFromProject($input: DeleteProjectNextItemInput!){
        deleteProjectNextItem(input: $input) {
          deletedItemId
        }
      }
      `,
      {
        input: {
          itemId: item.id,
          projectId
        }
      }
    )
    core.setOutput('deletedItemId', deletedItemId)
  } else {
    // Next, use the GraphQL API to add the issue to the project.
    const addResp = await octokit.graphql<ProjectAddItemResponse>(
      `mutation addIssueToProject($input: AddProjectNextItemInput!) {
      addProjectNextItem(input: $input) {
        projectNextItem {
          id
        }
      }`,
      {
        input: {
          projectId,
          contentId
        }
      }
    }`,
      {
        input: {
          contentId,
          projectId
        }
      }
    )
    core.setOutput('itemId', addResp.addProjectNextItem.projectNextItem.id)
  }
}

export function mustGetOwnerTypeQuery(ownerType?: string): 'organization' | 'user' {
  const ownerTypeQuery = ownerType === 'orgs' ? 'organization' : ownerType === 'users' ? 'user' : null

  if (!ownerTypeQuery) {
    throw new Error(`Unsupported ownerType: ${ownerType}. Must be one of 'orgs' or 'users'`)
  }

  return ownerTypeQuery
}
