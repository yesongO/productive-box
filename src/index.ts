import { Octokit } from '@octokit/rest';
import { config } from 'dotenv';
import type { VercelRequest, VercelResponse } from '@vercel/node';

import generateBarChart from './generateBarChart.js';
import githubQuery from './githubQuery.js';
import { createCommittedDateQuery, createContributedRepoQuery, userInfoQuery } from './queries.js';

/**
 * 환경변수 로드
 */
config({ path: ['.env'] });

interface IRepo {
  name: string;
  owner: string;
}

interface RepoInfo {
  name: string;
  owner: {
    login: string;
  };
  isFork: boolean;
}

interface Edge {
  node: {
    committedDate: string;
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    /**
     * 1. 유저 아이디 가져오기
     */
    const userResponse = await githubQuery(userInfoQuery).catch((error) => {
      console.error(`Unable to get username and id\n${error}`);
      res.status(500).send('Failed to get user info');
      return null;
    });
    if (!userResponse) return;

    const { login: username, id } = userResponse?.data?.viewer ?? {};
    if (!username || !id) {
      res.status(500).send('User info incomplete');
      return;
    }

    /**
     * 2. 기여한 저장소 정보 가져오기
     */
    const contributedRepoQuery = createContributedRepoQuery(username);
    const repoResponse = await githubQuery(contributedRepoQuery).catch((error) => {
      console.error(`Unable to get the contributed repo\n${error}`);
      res.status(500).send('Failed to get contributed repos');
      return null;
    });
    if (!repoResponse) return;

    if (repoResponse.message === 'Bad credentials') {
      console.error('Invalid GitHub token. Please renew the GH_TOKEN');
      res.status(401).send('Invalid GitHub token');
      return;
    }

    const repos: IRepo[] = repoResponse?.data?.user?.repositoriesContributedTo?.nodes
      .filter((repoInfo: RepoInfo) => !repoInfo?.isFork)
      .map((repoInfo: RepoInfo) => ({
        name: repoInfo?.name,
        owner: repoInfo?.owner?.login,
      }));

    /**
     * 3. 커밋 시간 정보 가져오기
     */
    const committedTimeResponseMap = await Promise.all(
      repos.map(({ name, owner }) => githubQuery(createCommittedDateQuery(id, name, owner))),
    ).catch((error) => {
      console.error(`Unable to get the commit info\n${error}`);
      res.status(500).send('Failed to get commit info');
      return null;
    });
    if (!committedTimeResponseMap) return;

    let morning = 0; // 6 - 12
    let daytime = 0; // 12 - 18
    let evening = 0; // 18 - 24
    let night = 0; // 0 - 6

    committedTimeResponseMap.forEach((committedTimeResponse) => {
      committedTimeResponse?.data?.repository?.defaultBranchRef?.target?.history?.edges.forEach((edge: Edge) => {
        const committedDate = edge?.node?.committedDate;
        const timeString = new Date(committedDate).toLocaleTimeString('en-US', {
          hour12: false,
          timeZone: process.env.TIMEZONE,
        });
        const hour = +timeString.split(':')[0];

        if (hour >= 6 && hour < 12) morning++;
        else if (hour >= 12 && hour < 18) daytime++;
        else if (hour >= 18 && hour < 24) evening++;
        else night++;
      });
    });

    const sum = morning + daytime + evening + night;
    if (!sum) {
      res.status(200).send('No commit data found');
      return;
    }

    /**
     * 4. 다이어그램 생성
     */
    const oneDay = [
      { label: '🌞 Morning', commits: morning },
      { label: '🌆 Daytime', commits: daytime },
      { label: '🌃 Evening', commits: evening },
      { label: '🌙 Night', commits: night },
    ];

    const lines = oneDay.reduce((prev, cur) => {
      const percent = (cur.commits / sum) * 100;
      const line = [
        `${cur.label}`.padEnd(10),
        `${cur.commits.toString().padStart(5)} commits`.padEnd(14),
        generateBarChart(percent, 21),
        String(percent.toFixed(1)).padStart(5) + '%',
      ];
      return [...prev, line.join(' ')];
    }, [] as string[]);

    /**
     * 5. Gist 업데이트
     */
    const octokit = new Octokit({ auth: `token ${process.env.GH_TOKEN}` });
    const gist = await octokit.gists
      .get({
        gist_id: `${process.env.GIST_ID}`,
      })
      .catch((error) => {
        console.error(`Unable to update gist\n${error}`);
        res.status(500).send('Failed to get gist');
        return null;
      });
    if (!gist) return;

    if (!gist.data.files) {
      console.error('No file found in the gist');
      res.status(404).send('No gist files found');
      return;
    }

    const filename = Object.keys(gist.data.files)[0];
    await octokit.gists.update({
      gist_id: `${process.env.GIST_ID}`,
      files: {
        [filename]: {
          filename: morning + daytime > evening + night ? "I'm an early 🐤" : "I'm a night 🦉",
          content: lines.join('\n'),
        },
      },
    });

    console.log('Success to update the gist 🎉');
    res.status(200).send('Success to update the gist 🎉');
  } catch (error) {
    console.error('Unexpected error:', error);
    res.status(500).send('Internal Server Error');
  }
}
