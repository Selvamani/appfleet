package io.appfleet.control.application;

import io.appfleet.control.application.web.ApplicationResponse;
import io.appfleet.control.application.web.CreateApplicationRequest;
import io.appfleet.control.application.web.CreateReleaseRequest;
import io.appfleet.control.application.web.ReleaseResponse;
import io.appfleet.control.common.NotFoundException;
import io.appfleet.control.security.TeamAccess;
import io.appfleet.control.security.TeamScope;
import io.appfleet.control.web.CursorCodec;
import io.appfleet.control.web.CursorPage;
import org.springframework.data.domain.Limit;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
public class ApplicationService {

    private final ApplicationRepository applicationRepository;
    private final ReleaseRepository releaseRepository;
    private final TeamAccess teamAccess;

    public ApplicationService(ApplicationRepository applicationRepository, ReleaseRepository releaseRespository, TeamAccess teamAccess) {
        this.applicationRepository = applicationRepository;
        this.releaseRepository = releaseRespository;
        this.teamAccess = teamAccess;
    }

    @Transactional
    public ApplicationResponse create(CreateApplicationRequest request) {
        // the caller names the team: nothing exists yet to hide, so this is a 403, not a 404
        teamAccess.require("application:create", request.ownerTeamId(),
                () -> new AccessDeniedException("The caller may not create applications for team " + request.ownerTeamId()));
        Application application = applicationRepository.save(new Application(request.name(), request.description(), request.ownerTeamId()));
        return ApplicationResponse.from(application);
    }

    @Transactional(readOnly = true)
    public ApplicationResponse get(UUID id) {
        Application application = applicationRepository.findById(id).orElseThrow(() -> new NotFoundException("Application", id));
        teamAccess.require("application:read", application.getOwnerTeamId(), () -> new NotFoundException("Application", id));
        return ApplicationResponse.from(application);
    }

    @Transactional(readOnly = true)
    public CursorPage<ApplicationResponse> list(UUID afterId, int limit) {
        TeamScope scope = teamAccess.scopeFor("application:read");
        if (!scope.all() && scope.teams().isEmpty()) {
            return new CursorPage<>(List.of(), null);
        }
        Limit fetch = Limit.of(limit+1);
        List<Application> rows;
        if (scope.all()) {
            rows = afterId == null
                    ? applicationRepository.findAllByOrderByIdAsc(fetch)
                    : applicationRepository.findByIdGreaterThanOrderByIdAsc(afterId, fetch);
        } else {
            rows = afterId == null
                    ? applicationRepository.findByOwnerTeamIdInOrderByIdAsc(scope.teams(), fetch)
                    : applicationRepository.findByOwnerTeamIdInAndIdGreaterThanOrderByIdAsc(scope.teams(), afterId, fetch);
        }

        boolean hasNext = rows.size() > limit;
        List<Application> page = hasNext ? rows.subList(0, limit) : rows;
        List<ApplicationResponse> items = page.stream().map(ApplicationResponse::from).toList();
        String nextCursor = hasNext ? CursorCodec.encode(page.get(page.size() -  1).getId()) : null;
        return new CursorPage<>(items, nextCursor);
    }

    @Transactional
    public ReleaseResponse createRelease(UUID applicationId, CreateReleaseRequest request) {
        Application application = applicationRepository.findById(applicationId).orElseThrow(() -> new NotFoundException("Application", applicationId));
        teamAccess.require("application:create", application.getOwnerTeamId(), () -> new NotFoundException("Application", applicationId));
        Release release = releaseRepository.save(new Release(application, request.version(), request.artifactRef(), request.checksum()));
        return ReleaseResponse.from(release);
    }

    @Transactional(readOnly = true)
    public ReleaseResponse getRelease(UUID applicationId, UUID releaseId) {
        Release release = releaseRepository.findByIdAndApplication_Id(releaseId, applicationId).orElseThrow(() -> new NotFoundException("Release", releaseId));
        teamAccess.require("application:read", release.getApplication().getOwnerTeamId(), () -> new NotFoundException("Release", releaseId));
        return ReleaseResponse.from(release);
    }
}
